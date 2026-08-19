var flow = require('@subiz/flow')
var {logError, xhrsend, randomString} = require('./common.js')
const servers = {
	iceServers: [{urls: ['stun:stun.l.google.com:19302']}],
}

// env = {RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, setTimeout, clearTimeout, setInterval, clearInterval, jsonify, parseJSON}
function WebRTCConn(options) {
	let {apiUrl, access_token, accid, agid, realtime, callAPI, env, onTrack, onEvent, collect} = options
	if (!collect) collect = function () {}
	if (!apiUrl) apiUrl = 'https://callcenter.subiz.com.vn/wc/'

	let dead = false
	callAPI = callAPI || xhrsend // allow hook
	let parseJSON = (str) => {
		try {
			return env.JSON.parse(str)
		} catch (e) {}
	}
	let jsonify = (str) => {
		try {
			return env.JSON.stringify(str)
		} catch (e) {}
	}
	let serverCalls = {}

	let call2Connection = {}
	let dialingRequest = {}
	let answerRequest = {}
	let endRequest = {}
	let callSeenAt = {}
	let publish

	// ICE consent is the primary liveness signal. RTP is only a secondary signal because
	// silence is a valid call state and must not cause an immediate local hangup.
	const disconnectGraceMs = 30000
	const rtpStaleMs = 90000
	const inviteStaleMs = 120000

	let sessionsByCall = {}
	let sessionsByConn = {}

	let getSessionByCall = (callid) => {
		if (!callid) return undefined
		return sessionsByCall[callid]
	}

	let getSessionByConn = (connId) => {
		if (!connId) return undefined
		return sessionsByConn[connId]
	}

	let getConnIdByCall = (callid) => {
		let session = getSessionByCall(callid)
		return (session && session.connId) || call2Connection[callid]
	}

	// Server trả `api_url` trong response /listen|/call = node đang neo
	// PeerConnection. Client pin session vào đó: các request per-call sau
	// (finish/ice/answer/dtmf/refer/hangup) đi thẳng node neo, khỏi qua hop proxy
	// gateway. Server không trả api_url (single node/dev) -> giữ nguyên apiUrl.
	let apiHostSuffixes = options.apiHostSuffixes || ['.subiz.com.vn']
	let normalizeApiBase = (u) => {
		if (!u || typeof u != 'string') return undefined
		if (u.slice(0, 8) != 'https://') return undefined
		let host = u.slice(8).split('/')[0].split(':')[0].toLowerCase()
		if (!host) return undefined
		let ok = false
		apiHostSuffixes.map((sfx) => {
			if (!sfx) return
			sfx = sfx.toLowerCase()
			if (sfx[0] == '.') {
				if (host.length > sfx.length && host.slice(-sfx.length) == sfx) ok = true
			} else if (host == sfx) ok = true
		})
		if (!ok) return undefined
		return u[u.length - 1] == '/' ? u : u + '/'
	}

	// chỉ nhận host thuộc whitelist — token nằm trong query string, nghe theo một
	// api_url giả là dâng token cho host lạ
	let pinSessionApiBase = (connId, body) => {
		let data = typeof body == 'string' ? parseJSON(body) : body
		let base = normalizeApiBase(data && data.api_url)
		let session = getSessionByConn(connId)
		if (!base || !session) return
		if (session.apiBase != base) console.info('[webrtc]', 'PIN API HOST', 'call_id', session.callid, base)
		session.apiBase = base
	}

	let apiBaseFor = (callid) => {
		let session = getSessionByCall(callid)
		return (session && session.apiBase) || apiUrl
	}

	// POST per-call: ưu tiên host đã pin; lỗi MẠNG (status 0/-1, không phải 4xx/5xx)
	// thì bỏ pin và thử lại một lần qua gateway mặc định — gateway vẫn proxy về
	// home được nên không bao giờ tệ hơn trước khi pin
	let postPerCall = (callid, path, body, cb) => {
		let base = apiBaseFor(callid)
		callAPI('post', base + path, body, (respBody, code) => {
			if ((!code || code < 0) && base != apiUrl) {
				console.warn('[webrtc]', 'PINNED HOST UNREACHABLE -> FALLBACK GATEWAY', 'call_id', callid, base)
				let session = getSessionByCall(callid)
				if (session && session.apiBase == base) session.apiBase = undefined
				return callAPI('post', apiUrl + path, body, cb || function () {})
			}
			cb && cb(respBody, code)
		})
	}

	let ensureSession = (callid) => {
		if (!callid) return undefined
		let session = sessionsByCall[callid]
		if (!session) {
			session = {
				callid,
				connId: undefined,
				peer: undefined,
				localStream: undefined,
				remoteStream: undefined,
				status: 'new',
			}
			sessionsByCall[callid] = session
		}
		return session
	}

	let bindSessionConnection = (callid, connId, peer) => {
		let session = ensureSession(callid)
		if (!session) return undefined
		let connOwner = getSessionByConn(connId)
		if (connOwner && connOwner !== session && connOwner.callid && connOwner.callid != callid) {
			console.warn(
				'[webrtc]',
				'SKIP bind connection owned by another call',
				'call_id',
				callid,
				'conn_id',
				connId,
				'owner_call_id',
				connOwner.callid,
			)
			return undefined
		}
		if (session.connId && session.connId != connId && sessionsByConn[session.connId] === session) {
			delete sessionsByConn[session.connId]
		}
		session.connId = connId
		if (peer) session.peer = peer
		if (connId) {
			sessionsByConn[connId] = session
			call2Connection[callid] = connId
		}
		return session
	}

	let markSessionEnded = (callid) => {
		let session = getSessionByCall(callid)
		if (!session) return
		session.status = 'ended'
		session.cancelled = true
	}

	let applySessionMuted = (session) => {
		if (!session || !session.localStream) return
		session.localStream.getAudioTracks().forEach((track) => {
			try {
				track.enabled = !session.muted
			} catch (e) {}
		})
	}

	let isCallEndedLocally = (callid) => {
		if (!callid) return false
		let call = serverCalls[callid]
		let session = getSessionByCall(callid)
		return !!endRequest[callid] || (session && session.cancelled) || (call && call.status == 'ended')
	}

	let rememberCall = (callid) => {
		if (callid && callSeenAt[callid] === undefined) callSeenAt[callid] = env.Date.now()
	}

	let expireCall = (call_info = {}) => {
		let callid = call_info.call_id
		if (!callid || isCallEndedLocally(callid)) return
		let call = Object.assign({}, dialingRequest[callid], serverCalls[callid], call_info, {
			call_id: callid,
			status: 'ended',
			ended: call_info.ended || env.Date.now(),
			hangup_code: call_info.hangup_code || 'cancel',
		})
		serverCalls[callid] = call
		publish({
			created: env.Date.now(),
			type: 'call_ended',
			data: {call_info: call},
		})
		return call
	}

	let clearDisconnectTimer = (session) => {
		if (!session || !session.disconnectTimer) return
		if (env.clearTimeout) env.clearTimeout(session.disconnectTimer)
		else env.clearInterval(session.disconnectTimer)
		session.disconnectTimer = undefined
		session.disconnectedAt = undefined
	}

	let expireTransportSession = (session, hangupCode) => {
		if (!session || session.transportEnded || isCallEndedLocally(session.callid)) return
		session.transportEnded = true
		clearDisconnectTimer(session)
		expireCall({
			call_id: session.callid,
			device_id: session.connId,
			hangup_code: hangupCode,
		})
	}

	let handlePeerStateChange = (callid, connId, peer) => {
		let session = getSessionByConn(connId)
		if (!session || session.callid != callid || session.peer !== peer || session.transportEnded) return
		let state = peer.connectionState
		let iceState = peer.iceConnectionState
		let now = env.Date.now()
		let connected = state == 'connected' || iceState == 'connected' || iceState == 'completed'
		let failed = state == 'failed' || iceState == 'failed'
		let closed = state == 'closed' || iceState == 'closed'
		let disconnected = state == 'disconnected' || iceState == 'disconnected'

		if (failed || closed) {
			return expireTransportSession(session, failed ? 'webrtc_transport_failed' : 'webrtc_transport_closed')
		}

		if (disconnected) {
			if (session.disconnectTimer) return
			session.disconnectedAt = now
			session.disconnectTimer = env.setTimeout(() => {
				let current = getSessionByConn(connId)
				if (!current || current.peer !== peer || current.transportEnded) return
				let currentState = peer.connectionState
				let currentIceState = peer.iceConnectionState
				if (currentState != 'disconnected' && currentIceState != 'disconnected') {
					clearDisconnectTimer(current)
					return
				}
				expireTransportSession(current, 'webrtc_disconnected_timeout')
			}, disconnectGraceMs)
			return
		}

		if (connected) {
			session.everConnected = true
			session.lastTransportHealthyAt = now
		}
		clearDisconnectTimer(session)
	}

	let getLocalEndedCall = (callid) => {
		return (
			this.matchCall(callid) || {
				call_id: callid,
				ended: endRequest[callid] || env.Date.now(),
				status: 'ended',
				hangup_code: 'cancel',
			}
		)
	}

	// to receive incoming call
	realtime.subscribe([`webrtc.account.${accid}.agent.${agid}`])

	let initSession = (callid, cb) => {
		let connId = 'webrtc' + randomString(20)
		let peer = new env.RTCPeerConnection(servers)
		// call này đã có session gắn connection khác (listenCall rồi mới answerCall,
		// hoặc retry join): phải đóng connection cũ trước khi bind cái mới — peer bị
		// thay không tự chết, ICE/mic của nó tiếp tục chạy (leak)
		let prev = getSessionByCall(callid)
		let prevMuted = prev && prev.muted
		if (prev && prev.peer && prev.connId && prev.connId != connId) {
			cleanupConnection(prev.connId)
		}
		let session = bindSessionConnection(callid, connId, peer)
		if (session) {
			session.status = 'connecting'
			if (prevMuted !== undefined) session.muted = prevMuted
		}
		peer.ontrack = (event) => {
			let session = getSessionByConn(connId)
			// session.peer !== peer: connection này đã bị thay bởi lần bind mới hơn —
			// track của nó là track mồ côi, không được đưa lên UI
			if (!session || session.peer !== peer || isCallEndedLocally(session.callid)) {
				if (event.streams && event.streams[0]) stopStream(event.streams[0], connId)
				return
			}
			if (event.streams && event.streams[0]) session.remoteStream = event.streams[0]
			onTrack && onTrack(event)
		}
		let onPeerStateChange = () => handlePeerStateChange(callid, connId, peer)
		peer.onconnectionstatechange = onPeerStateChange
		peer.oniceconnectionstatechange = onPeerStateChange
		waitForRemoteDescription[connId] = new env.Promise((rs) => (readyToSendCandidateResolve[connId] = rs))

		peer.onicecandidate = (event) => {
			if (!event.candidate) return
			if (dead) return
			postPerCall(
				callid,
				`ice-candidates?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&account_id=${accid}`,
				jsonify(event.candidate),
			)
		}

		// topic agent đã subscribe lúc khởi tạo store, ở đây chỉ cần topic connection.
		// .catch bắt buộc: subscribe reject mà không catch thì cb không bao giờ được
		// gọi -> promise của makeCall/answerCall treo vĩnh viễn
		realtime
			.subscribe([`webrtc.account.${accid}.agent.${agid}.webrtc_connection.${connId}`])
			.then((out) => {
				if (out && out.error) return cb(out.error, connId)
				return cb(undefined, connId)
			})
			.catch((err) => cb(err || 'subscribe_failed', connId))
	}

	let checkIceConnected = (peer, cb, shouldStop) =>
		flow.loop(
			() =>
				new env.Promise((rs) => {
					if (shouldStop && shouldStop()) {
						cb && cb('cancelled')
						return rs(false)
					}
					if (!peer || peer.signalingState == 'closed' || peer.iceConnectionState == 'closed') {
						cb && cb('closed')
						return rs(false)
					}
					if (peer.connectionState == 'failed' || peer.iceConnectionState == 'failed') {
						cb && cb('failed')
						return rs(false)
					}
					let pass = peer && (peer.iceConnectionState == 'connected' || peer.iceConnectionState == 'completed')
					if (!pass) return env.setTimeout((_) => rs(true), 100) // keep looping util connected
					cb && cb()
					rs(false)
				}),
		)

	let readyToSendCandidateResolve = {}
	let waitForRemoteDescription = {}
	let negotiationQueue = {} // connId -> promise chain, xử lý tuần tự các renegotiation offer
	let stopStream = (stream, connId) => {
		if (!stream) return
		stream.getTracks().forEach((track) => {
			try {
				track.stop()
				track.enabled = false
			} catch (e) {}
		})
	}

	let cleanupConnection = (connId) => {
		if (!connId) return
		let session = getSessionByConn(connId)
		let peer = session && session.peer
		if (session) {
			session.transportEnded = true
			clearDisconnectTimer(session)
		}
		if (peer) {
			if (peer.getSenders) {
				peer.getSenders().forEach((sender) => {
					try {
						if (sender.track) sender.track.stop()
					} catch (e) {}
					if (sender.replaceTrack) {
						let promise = sender.replaceTrack(null)
						if (promise && promise.catch) promise.catch(() => {})
					}
				})
			}
			if (peer.getReceivers) {
				peer.getReceivers().forEach((receiver) => {
					try {
						if (receiver.track) receiver.track.stop()
					} catch (e) {}
				})
			}
			if (peer.getTransceivers) {
				peer.getTransceivers().forEach((transceiver) => {
					try {
						if (transceiver.stop && peer.signalingState !== 'closed') transceiver.stop()
					} catch (e) {}
				})
			}
			try {
				if (peer.signalingState !== 'closed') peer.close()
			} catch (e) {}
		}

		let localStream = session && session.localStream
		let remoteStream = session && session.remoteStream
		stopStream(localStream, connId)
		stopStream(remoteStream, connId)
		if (session) {
			session.peer = undefined
			session.localStream = undefined
			session.remoteStream = undefined
			session.status = 'ended'
			delete sessionsByConn[connId]
			if (session.callid && sessionsByCall[session.callid] === session) delete sessionsByCall[session.callid]
		}
		delete waitForRemoteDescription[connId]
		delete readyToSendCandidateResolve[connId]
		delete negotiationQueue[connId]
	}

	let cleanupCallConnection = (callid, connId) => {
		let session = getSessionByCall(callid) || getSessionByConn(connId)
		if (session && session.callid == callid && session.connId) connId = session.connId
		if (session && !connId) connId = session.connId
		if (!connId) return
		let mappedCallId = session && session.callid
		if (mappedCallId && mappedCallId != callid) return
		markSessionEnded(callid)
		cleanupConnection(connId)
	}

	let cleanEndedCall = () => {
		if (dead) return env.clearInterval(_endcalInterval)
		Object.keys(endRequest).map((callid) => {
			if (env.Date.now() - endRequest[callid] > 60000) delete endRequest[callid]
		})

		Object.keys(answerRequest).map((callid) => {
			if (env.Date.now() - answerRequest[callid] > 60000) delete answerRequest[callid]
		})

		Object.keys(serverCalls).map((callid) => {
			let call = serverCalls[callid]
			if (!call) return delete serverCalls[callid]
			if (call.status != 'ended') return
			// call.ended có thể thiếu -> NaN > 60000 luôn false, entry không bao giờ được dọn
			if (env.Date.now() - (call.ended || 0) > 60000) delete serverCalls[callid]
		})

		Object.keys(dialingRequest).map((callid) => {
			let call = this.matchCall(callid)
			if (!call) return delete dialingRequest[callid]
			if (call.status != 'ended') return
			if (env.Date.now() - (call.ended || 0) > 60000) delete dialingRequest[callid]
		})

		Object.keys(call2Connection).map((callid) => {
			let call = this.matchCall(callid)
			if (!call) return delete call2Connection[callid]
			if (call.status != 'ended') return
			if (env.Date.now() - (call.ended || 0) > 60000) delete call2Connection[callid]
		})

		Object.keys(callSeenAt).map((callid) => {
			let call = serverCalls[callid] || dialingRequest[callid]
			if (!call || (call.status == 'ended' && env.Date.now() - (call.ended || 0) > 60000)) {
				delete callSeenAt[callid]
			}
		})
	}
	let _endcalInterval = env.setInterval(cleanEndedCall, 120000)

	let refreshRtpStats = (session) => {
		let peer = session && session.peer
		if (!peer || !peer.getStats || session.transportEnded) return
		let statsPromise
		try {
			statsPromise = peer.getStats()
		} catch (e) {
			return
		}
		if (!statsPromise || !statsPromise.then) return
		statsPromise
			.then((reports) => {
				if (!reports || !reports.forEach || session.peer !== peer || session.transportEnded) return
				let packets = 0
				let hasRtpReport = false
				reports.forEach((report) => {
					if (report.type != 'inbound-rtp' && report.type != 'outbound-rtp') return
					let kind = report.kind || report.mediaType
					if (kind && kind != 'audio') return
					hasRtpReport = true
					packets += Number(report.packetsReceived || 0) + Number(report.packetsSent || 0)
				})
				if (!hasRtpReport) return
				let now = env.Date.now()
				// A renegotiation may replace the RTP stream and reset counters. Any counter
				// change, including a decrease, is therefore evidence of fresh media activity.
				if (session.rtpPackets === undefined || packets != session.rtpPackets) session.lastRtpAt = now
				if (session.rtpObservedAt === undefined) session.rtpObservedAt = now
				session.rtpPackets = packets

				let call = serverCalls[session.callid] || dialingRequest[session.callid] || {}
				let isInvite =
					!call.status ||
					call.status == 'new' ||
					call.status == 'dialing' ||
					call.status == 'ringing' ||
					call.status == 'pending'
				let lastRtpAt = session.lastRtpAt || session.rtpObservedAt
				if (!isInvite && session.everConnected && lastRtpAt && now - lastRtpAt > rtpStaleMs) {
					expireTransportSession(session, 'webrtc_rtp_timeout')
				}
			})
			.catch(() => {})
	}

	let checkCallLiveness = () => {
		if (dead) return env.clearInterval(_livenessInterval)
		let now = env.Date.now()
		Object.keys(sessionsByCall).map((callid) => {
			let session = sessionsByCall[callid]
			if (!session || !session.peer) return
			handlePeerStateChange(callid, session.connId, session.peer)
			refreshRtpStats(session)
		})

		let calls = Object.assign({}, dialingRequest, serverCalls)
		Object.keys(calls).map((callid) => {
			let call = calls[callid]
			if (!call || call.status == 'ended' || getSessionByCall(callid)) return
			rememberCall(callid)
			let isInvite =
				!call.status ||
				call.status == 'new' ||
				call.status == 'dialing' ||
				call.status == 'ringing' ||
				call.status == 'pending'
			if (isInvite && now - callSeenAt[callid] > inviteStaleMs) {
				expireCall({call_id: callid, hangup_code: 'invite_timeout'})
			}
		})
	}
	let _livenessInterval = env.setInterval(checkCallLiveness, 5000)

	let endcallCb = {}
	publish = (ev) => {
		if (ev.type == 'call_ended') {
			let callid = ev.data && ev.data.call_info && ev.data.call_info.call_id
			let callInfo = ev.data && ev.data.call_info
			let serverCall = serverCalls[callid] || {}
			let connId = getConnIdByCall(callid) || (callInfo && callInfo.device_id) || serverCall.device_id
			markSessionEnded(callid)
			cleanupCallConnection(callid, connId)
			// do not clean up this now or some functions cannot work after the call ended
			// DONOT: delete call2Connection[callid]

			let arr = endcallCb[callid]
			if (arr && arr.length > 0 && arr.map) arr.map((cb) => cb())
			delete endcallCb[callid]
		}

		let direction = ev.data && ev.data.call_info && ev.data.call_info.direction
		if (direction == 'incoming') ev.data.call_info.direction = 'inbound'
		if (direction == 'outgoing') ev.data.call_info.direction = 'outbound'
		onEvent && onEvent(ev)
	}

	this.shutdown = () => {
		if (dead) return
		dead = true
		env.clearInterval(_livenessInterval)
		env.clearInterval(_endcalInterval)
		Object.keys(sessionsByConn).map((connId) => cleanupConnection(connId))
	}

	this.matchCall = (callid) => {
		if (!callid || callid == '*' || callid == '-') {
			let calls = Object.assign({}, serverCalls)
			Object.keys(dialingRequest).map((callid) => {
				let call = calls[callid]
				if (!call && dialingRequest[callid]) {
					calls[callid] = dialingRequest[callid]
				}
			})

			Object.keys(calls).map((callid) => {
				let call = calls[callid]
				if (!endRequest[callid]) return
				if (!call || call.status == 'ended') return
				calls[callid] = Object.assign({}, call, {
					call_id: callid,
					ended: endRequest[callid],
					status: 'ended',
					hangup_code: 'cancel',
				})
			})

			// copy-on-write: calls là shallow copy nên value vẫn trỏ vào object trong
			// serverCalls/dialingRequest — mutate trực tiếp là sửa lén state của store
			Object.keys(answerRequest).map((callid) => {
				let call = calls[callid]
				if (!call) return
				calls[callid] = Object.assign({}, call, {answer_requested: answerRequest[callid]})
			})

			Object.keys(calls).map((callid) => {
				let call = calls[callid]
				let direction = call && call.direction
				if (direction == 'incoming') calls[callid] = Object.assign({}, call, {direction: 'inbound'})
				if (direction == 'outgoing') calls[callid] = Object.assign({}, call, {direction: 'outbound'})
			})
			return calls
		}

		let call = serverCalls[callid]
		if (!call && dialingRequest[callid]) call = dialingRequest[callid]
		if (endRequest[callid] && call && call.status != 'ended') {
			call = Object.assign({}, call, {
				call_id: callid,
				ended: endRequest[callid],
				status: 'ended',
				hangup_code: 'cancel',
			})
		}
		if (answerRequest[callid]) call = Object.assign({}, call, {answer_requested: answerRequest[callid]})
		let direction = call && call.direction
		// copy-on-write: call có thể vẫn là object gốc trong serverCalls/dialingRequest
		if (direction == 'incoming') call = Object.assign({}, call, {direction: 'inbound'})
		if (direction == 'outgoing') call = Object.assign({}, call, {direction: 'outbound'})

		return call
	}

	// debug only, dump internal state so we can see why a call disappears from the store
	this.debugState = () => {
		let calls = {}
		Object.keys(serverCalls).map((callid) => {
			let call = serverCalls[callid] || {}
			calls[callid] = {
				status: call.status,
				direction: call.direction,
				device_id: call.device_id,
				started: call.started,
				answered: call.answered,
				ended: call.ended,
				hangup_code: call.hangup_code,
			}
		})

		let sessions = {}
		Object.keys(sessionsByCall).map((callid) => {
			let ss = sessionsByCall[callid] || {}
			let peer = ss.peer
			sessions[callid] = {
				conn_id: ss.connId,
				status: ss.status,
				cancelled: !!ss.cancelled,
				peer: !!peer,
				connection: peer && peer.connectionState,
				ice: peer && peer.iceConnectionState,
				signaling: peer && peer.signalingState,
				ever_connected: !!ss.everConnected,
				disconnected_at: ss.disconnectedAt,
				last_transport_healthy_at: ss.lastTransportHealthyAt,
				last_rtp_at: ss.lastRtpAt,
				rtp_packets: ss.rtpPackets,
				local_stream: !!ss.localStream,
				remote_stream: !!ss.remoteStream,
				muted: !!ss.muted,
			}
		})

		return {
			api_url: apiUrl,
			server_calls: calls,
			dialing_requests: Object.keys(dialingRequest),
			end_requests: Object.keys(endRequest),
			answer_requests: Object.keys(answerRequest),
			call2conn: Object.assign({}, call2Connection),
			sessions,
		}
	}

	this.expireCall = expireCall

	realtime.onEvent((ev) => {
		if (dead) return
		if (!ev || !ev.type || !ev.data) return

		if (ev.type == 'webrtc_candidate_added') {
			let ice_candidate = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.ice_candidate
			let connId = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.connection_id
			if (!connId) return
			if (!ice_candidate) return
			let waitRemoteDescription = waitForRemoteDescription[connId]
			let session = getSessionByConn(connId)
			let peer = session && session.peer

			if (!peer || !waitRemoteDescription || isCallEndedLocally(session && session.callid)) {
				console.info('[webrtc]', 'IGNORE CANDIDATE FOR CLOSED CONNECTION', connId)
				return
			}

			return waitRemoteDescription
				.then(() => {
					let session = getSessionByConn(connId)
					let peer = session && session.peer
					if (!peer || isCallEndedLocally(session && session.callid)) return
					let candidate = parseJSON(ice_candidate)
					if (!candidate) return
					return peer.addIceCandidate(candidate)
				})
				.catch((err) => {
					// không catch thì thành unhandled rejection; candidate hỏng chỉ cần log
					console.error('[webrtc]', 'ADD CANDIDATE FAILED', connId, err)
					logError(accid, agid, (err && err.message) || err, 'addIceCandidate')
				})
		}

		if (ev.type == 'webrtc_negotiation_offered') {
			let jsonoffer = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.offer
			let connId = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.connection_id
			let session = getSessionByConn(connId)
			let peer = session && session.peer
			if (!peer || isCallEndedLocally(session && session.callid)) return
			let negid = ev.id
			// let negid = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.negotiation_id
			let offer = parseJSON(jsonoffer)
			if (!offer) return
			// Xử lý TUẦN TỰ các offer trên cùng connection: 2 offer chồng nhau mà cùng
			// setRemoteDescription là dính InvalidStateError (glare). Re-fetch session/
			// peer bên trong vì đến lượt chạy thì connection có thể đã bị thay/đóng.
			let handleOffer = () => {
				let session = getSessionByConn(connId)
				let peer = session && session.peer
				if (!peer || isCallEndedLocally(session.callid)) return
				return peer
					.setRemoteDescription(offer)
					.then(() => {
						let resolveReadyToSendCandidate = readyToSendCandidateResolve[connId]
						session = getSessionByConn(connId)
						if (!session || isCallEndedLocally(session.callid) || !resolveReadyToSendCandidate) return
						resolveReadyToSendCandidate()
						peer = session.peer
						let stream = session.localStream
						if (!peer) return
						stream &&
							stream.getTracks().forEach((track) => {
								let replaced = false
								peer.getSenders().forEach((sender) => {
									if (!sender.track) return
									if (sender.track.kind != track.kind) return
									sender.replaceTrack(track)
									replaced = true
								})

								if (!replaced) {
									peer.addTrack(track, stream)
								}
							})
						return peer.createAnswer()
					})
					.then((answer) => {
						if (!answer) return
						session = getSessionByConn(connId)
						peer = session && session.peer
						if (!peer || isCallEndedLocally(session && session.callid)) return
						return peer.setLocalDescription(answer).then(() => {
							// call_id: server dùng để log theo cuộc gọi
							let path = `finish?x-access-token=${access_token}&connection_id=${connId}&call_id=${session.callid}&version=2&negotiation_id=${negid}&account_id=${accid}`
							postPerCall(session.callid, path, jsonify(answer), function (body, code) {
								if (code !== 200) {
									logError(accid, agid, body, 'finish:295')
									return console.error('CANNOT FINISH', body)
								}
								return
							})
						})
					})
			}
			negotiationQueue[connId] = (negotiationQueue[connId] || env.Promise.resolve()).then(handleOffer).catch((err) => {
				console.error('[webrtc]', 'NEGOTIATION FAILED', connId, err)
				logError(accid, agid, (err && err.message) || err, 'negotiation_offered')
			})
			return
		}

		let call_info = ev.data.call_info || {}
		let callid = call_info.call_id
		if (!callid) return
		rememberCall(callid)
		let type = ev.type
		if (type === 'call_invited') {
			if (agid == call_info.from_number) return // ignore our own invite
			serverCalls[callid] = call_info
			return publish(ev)
		}

		if (type == 'call_ended') {
			let wasEnded = isCallEndedLocally(callid)
			serverCalls[callid] = call_info
			if (wasEnded) return // already ended and published locally, ignore duplicate server event
			return publish(ev)
		}

		if (ev.type === 'call_invite_expired') {
			if (getSessionByConn(call_info.device_id)) return // this call invitation is expired by us => ignore
			serverCalls[callid] = call_info
			publish(Object.assign({}, ev, {type: 'call_ended'})) // fake ended call
			return
		}

		let connId = call_info.device_id
		let session = getSessionByConn(connId)
		let peer = session && session.peer
		if (!peer) return
		if (type == 'call_ringing' || type == 'call_joined') {
			session = bindSessionConnection(callid, connId, peer)
			if (!session) return
			session.status = call_info.status
			serverCalls[callid] = call_info
			return publish(ev)
		}
	})

	this.makeCall = (number, fromnumber, streamPm, callid, campaignid, outboundcallentryid, channel) => {
		if (!callid) callid = 'webcall-' + randomString(30)
		if (isCallEndedLocally(callid)) {
			if (streamPm && streamPm.then) {
				streamPm.then((stream) => stopStream(stream, callid)).catch(() => {})
			}
			return new env.Promise((rs) => rs(getLocalEndedCall(callid)))
		}
		// thiếu stream promise thì trả lỗi có cấu trúc thay vì throw giữa executor
		if (!streamPm || !streamPm.then) return env.Promise.resolve({error: 'no_stream'})
		let now = env.Date.now()
		rememberCall(callid)
		let call = {
			account_id: accid,
			call_id: callid,
			direction: 'outbound',
			channel: channel || 'call',
			member_id: agid,
			started: now,
			status: 'dialing',
			to_number: number,
			from_number: fromnumber,
			mic: 'waiting',
		}
		dialingRequest[callid] = call
		publish({created: now, type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			streamPm
				.then((stream) => {
					call.mic = 'ready'
					if (isCallEndedLocally(callid)) {
						delete dialingRequest[callid]
						stopStream(stream, callid)
						return rs(getLocalEndedCall(callid))
					}
					publish({created: now, type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
					this.joinCall(callid, stream, (err, connId) => {
						if (isCallEndedLocally(callid)) {
							delete dialingRequest[callid]
							cleanupCallConnection(callid, connId)
							return rs(getLocalEndedCall(callid))
						}
						if (err) {
							delete dialingRequest[callid]
							endRequest[callid] = env.Date.now()
							publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
							return rs({error: err})
						}

						// encodeURIComponent bắt buộc: số dạng "+84..." không encode thì dấu +
						// bị server decode thành khoảng trắng
						let path = `call?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number=${encodeURIComponent(
							number,
						)}&from_number=${encodeURIComponent(fromnumber || '')}&account_id=${accid}`
						if (channel) path += `&channel=${encodeURIComponent(channel)}`
						if (outboundcallentryid) path += `&outbound_call_entry_id=${encodeURIComponent(outboundcallentryid)}`
						if (campaignid) path += `&campaign_id=${encodeURIComponent(campaignid)}`
						if (isCallEndedLocally(callid)) {
							delete dialingRequest[callid]
							cleanupCallConnection(callid, connId)
							return rs(getLocalEndedCall(callid))
						}

						postPerCall(callid, path, undefined, (body, code) => {
							if (isCallEndedLocally(callid)) {
								delete dialingRequest[callid]
								cleanupCallConnection(callid, connId)
								return rs(getLocalEndedCall(callid))
							}
							if (code != 200) {
								logError(accid, agid, body, 'makeCall:365')
								delete dialingRequest[callid]
								endRequest[callid] = env.Date.now()
								publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
								return rs({error: body})
							}
							body = parseJSON(body)
							pinSessionApiBase(connId, body) // node neo PC xác nhận lại host trong response /call
							// backend có thể chỉ trả {"ok":true} chứ không kèm call info. Trong trường hợp đó phải
							// giữ nguyên dialing request, nếu không cuộc gọi sẽ biến mất khỏi store cho tới khi kết thúc
							if (body && body.call_id) {
								serverCalls[callid] = body
								delete dialingRequest[callid]
							}

							let call = this.matchCall(callid)
							if (call && call.status == 'ended') return rs(call)
							if (!endcallCb[callid]) endcallCb[callid] = []
							endcallCb[callid].push(() => rs(this.matchCall(callid)))
						})
					})
				})
				.catch((err) => rs({error: err}))
		})
	}

	this.hangupCall = (callid) => {
		if (!callid) return
		if (isCallEndedLocally(callid)) return
		endRequest[callid] = env.Date.now()

		let call = serverCalls[callid]
		if (!call) {
			call = {call_id: callid}
			serverCalls[callid] = call
		}
		call.status = 'ended'
		call.hangup_code = 'cancel'
		call.ended = env.Date.now()
		markSessionEnded(callid)
		// chốt host pin TRƯỚC publish: publish(call_ended) sẽ dọn session (mất pin)
		let hangupBase = apiBaseFor(callid)
		publish({
			created: env.Date.now(),
			type: 'call_ended',
			data: {call_info: Object.assign({}, call, {call_id: callid, status: 'ended'})},
		})
		let path = `hangup?x-access-token=${access_token}&call_id=${callid}&account_id=${accid}`
		callAPI('post', hangupBase + path, undefined, (body, code) => {
			// lỗi mạng tới host pin -> thử lại qua gateway (gateway locate theo call_id)
			if ((!code || code < 0) && hangupBase != apiUrl) callAPI('post', apiUrl + path, undefined, function () {})
		})
	}

	this.listenCall = (callid, cb) => {
		let start = env.Date.now()
		initSession(callid, (err, connId) => {
			if (err) {
				cleanupConnection(connId)
				return cb(err)
			}
			if (isCallEndedLocally(callid)) {
				cleanupCallConnection(callid, connId)
				return cb('call_ended')
			}
			// /listen luôn đi qua gateway mặc định (chưa biết node neo); response
			// mang api_url của node neo PC -> pin cho các request per-call sau
			let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&account_id=${accid}`
			callAPI('post', url, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'listenCall:399')
				if (code == 200) pinSessionApiBase(connId, body)
				collect('listen_call', callid, env.Date.now() - start)
				if (isCallEndedLocally(callid)) {
					cleanupCallConnection(callid, connId)
					return cb('call_ended')
				}
				return code != 200 ? cb(body) : cb()
			})
		})
	}

	this.joinCall = (callid, stream, cb) => {
		let start = env.Date.now()
		initSession(callid, (err, connId) => {
			if (err) {
				stopStream(stream, connId)
				cleanupConnection(connId)
				return cb(err, connId)
			}
			let session = getSessionByConn(connId)
			if (session) {
				session.localStream = stream
				session.status = 'joining'
				applySessionMuted(session)
			}
			if (isCallEndedLocally(callid)) {
				cleanupCallConnection(callid, connId)
				return cb('call_ended', connId)
			}
			// /listen luôn đi qua gateway mặc định (chưa biết node neo); response
			// mang api_url của node neo PC -> pin cho các request per-call sau
			let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&talk=true&account_id=${accid}`
			callAPI('post', url, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'joinCall:413')
				if (code == 200) pinSessionApiBase(connId, body)
				collect('join_call', callid, env.Date.now() - start)
				if (isCallEndedLocally(callid)) {
					cleanupCallConnection(callid, connId)
					return cb('call_ended', connId)
				}
				if (code != 200) {
					return cb(body, connId)
				}
				let session = getSessionByConn(connId)
				checkIceConnected(
					session && session.peer,
					(err) => {
						if (err) {
							cleanupCallConnection(callid, connId)
							return cb(err, connId)
						}
						if (isCallEndedLocally(callid)) {
							cleanupCallConnection(callid, connId)
							return cb('call_ended', connId)
						}
						let session = getSessionByConn(connId)
						if (session) session.status = 'connected'
						cb(undefined, connId)
					},
					() => isCallEndedLocally(callid) || !getSessionByConn(connId),
				)
			})
		})
	}

	this.answerCall = (callid, stream) => {
		let call = serverCalls[callid]
		if (call && call.status == 'ended') return env.Promise.resolve({error: 'call_ended'})
		let now = env.Date.now()
		// call có thể chưa có trong serverCalls -> trả object tối thiểu thay vì body: undefined
		if (answerRequest[callid]) return env.Promise.resolve({body: call || this.matchCall(callid) || {call_id: callid}})
		answerRequest[callid] = now
		publish({created: env.Date.now(), type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			if (isCallEndedLocally(callid)) {
				stopStream(stream, callid)
				return rs({body: getLocalEndedCall(callid)})
			}
			this.joinCall(callid, stream, (err, connId) => {
				if (isCallEndedLocally(callid)) {
					delete answerRequest[callid]
					cleanupCallConnection(callid, connId)
					return rs({body: getLocalEndedCall(callid)})
				}
				if (err) {
					delete answerRequest[callid]
					endRequest[callid] = now
					publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
					return rs({error: err})
				}
				let path = `answer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&account_id=${accid}`
				if (isCallEndedLocally(callid)) {
					delete answerRequest[callid]
					cleanupCallConnection(callid, connId)
					return rs({body: getLocalEndedCall(callid)})
				}
				postPerCall(callid, path, undefined, (body, code) => {
					if (isCallEndedLocally(callid)) {
						delete answerRequest[callid]
						cleanupCallConnection(callid, connId)
						return rs({body: getLocalEndedCall(callid)})
					}
					body = parseJSON(body)
					if (code != 200) {
						logError(accid, agid, body, 'answerCall:442')
						delete answerRequest[callid]
						endRequest[callid] = now
						publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
						return rs({error: body})
					}
					return rs({body})
				})
			})
		})
	}

	this.sendDtmf = (key, callid) =>
		new env.Promise((rs) => {
			if (!callid) return rs({body: {}})
			let connId = getConnIdByCall(callid)
			if (!connId) return rs({body: {}})
			let path = `dtmf?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&key=${encodeURIComponent(
				key,
			)}&account_id=${accid}`
			postPerCall(callid, path, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'sendDtmf:463')
				body = parseJSON(body)
				return code != 200 ? rs({error: body}) : rs({body})
			})
		})

	this.transferCall = (tonumber, callid) =>
		new env.Promise((rs) => {
			if (!callid) return rs({})
			let connId = getConnIdByCall(callid)
			if (!connId) return rs({body: {}})
			let start = env.Date.now()
			let path = `refer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number=${encodeURIComponent(
				tonumber,
			)}&account_id=${accid}`
			postPerCall(callid, path, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'transferCall:478')
				collect('transfer_call', callid, env.Date.now() - start)
				body = parseJSON(body)
				return code != 200 ? rs({error: body}) : rs({body})
			})
		})

	this.setCallMuted = (callid, muted) => {
		let session = ensureSession(callid)
		if (!session) return {error: 'call_not_found'}
		session.muted = !!muted
		applySessionMuted(session)
		return {body: {muted: session.muted}}
	}

	this.isCallMuted = (callid) => {
		let session = getSessionByCall(callid)
		return !!(session && session.muted)
	}
}

module.exports = WebRTCConn
