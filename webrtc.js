var flow = require('@subiz/flow')
var {logError, xhrsend, randomString} = require('./common.js')
const servers = {
	iceServers: [{urls: ['stun:stun.l.google.com:19302']}],
}

// let connId = 'webrtc' + randomString(20)
// env = {RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, setTimeout, setInterval, jsonify, parseJSON}
// set env._is_webrtc_local to true for local testing
function WebRTCConn(options) {
	let {apiUrl, access_token, accid, agid, realtime, callAPI, env, onTrack, onEvent, collect} = options
	if (!collect) collect = function () {}
	if (!apiUrl) {
		apiUrl = 'https://callcenter.subiz.com.vn/wc/'
		if (env._is_webrtc_local) apiUrl = 'http://localhost:8008/'
	}

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
	let streams = {}
	let serverCalls = {}

	let call2Connection = {}
	let dialingRequest = {}
	let answerRequest = {}
	let endRequest = {}

	let peers = {}

	// to receive incomming call
	realtime.subscribe([`webrtc.account.${accid}.agent.${agid}`])

	let initSession = (cb) => {
		let connId = 'webrtc' + randomString(20)
		let peer = new env.RTCPeerConnection(servers)
		peers[connId] = peer
		peer.ontrack = (event) => onTrack && onTrack(event)
		waitForRemoteDescription[connId] = new env.Promise((rs) => (readyToSendCandidateResolve[connId] = rs))

		peer.onicecandidate = (event) => {
			if (!event.candidate) return
			let url = `${apiUrl}ice-candidates?x-access-token=${access_token}&connection_id=${connId}`
			callAPI('post', url, jsonify(event.candidate))
		}

		peer.onnegotiationneeded = (ev) => console.log('NNNEED RE-NEGOTIATION', ev)
		realtime
			.subscribe([
				`webrtc.account.${accid}.agent.${agid}`,
				`webrtc.account.${accid}.agent.${agid}.webrtc_connection.${connId}`,
			])
			.then((err) => {
				// create peer connection
				cb(err, connId)
			})
	}

	let checkIceConnected = (peer, cb) =>
		flow.loop(
			() =>
				new env.Promise((rs) => {
					let pass = peer && (peer.iceConnectionState == 'connected' || peer.iceConnectionState == 'completed')
					if (!pass) return env.setTimeout((_) => rs(true), 100) // keep looping util connected
					cb && cb()
					rs(false)
				}),
		)

	let readyToSendCandidateResolve = {}
	let waitForRemoteDescription = {}
	let stopStream = (stream) => {
		if (!stream) return
		stream.getTracks().forEach((track) => {
			track.stop()
			track.enabled = false
		})
	}

	let syncCallWithServer = () => {
		let url = `${apiUrl}calls?x-access-token=${access_token}`
		callAPI('get', url, undefined, function (body, code) {
			if (code != 200) return
			body = parseJSON(body) || []
			let newCalls = {}
			if (!body.map) return
			body.map((call) => {
				newCalls[call.call_id] = call
			})

			// end all local calls that not found on the server
			Object.keys(serverCalls).map((i) => {
				let call = serverCalls[i]
				if (!call) return delete serverCalls[i]
				let callid = call.call_id
				if (newCalls[callid]) return

				// calls that are missing on the server
				newCalls[callid] = call
				if (!call.ended) call.ended = env.Date.now()
				if (!call.hangup_code) call.hangup_code = 'cancel'
				if (call.status != 'ended') {
					call.status = 'ended'
					publish({
						created: env.Date.now(),
						type: 'call_ended',
						data: {call_info: {hanup_code: 'outdated', call_id: callid}},
					})
				}
			})

			serverCalls = {}
			Object.values(newCalls).map((call) => {
				if (!call) return false
				if (call.status == 'ended') {
					// receive ended call
					serverCalls[call.call_id] = call
					return
				}
				// keep all dialing incomming calls
				if (call.status == 'dialing' && (call.direction == 'incoming' || call.direction == 'inbound')) {
					serverCalls[call.call_id] = call
					return
				}

				let connId = call.device_id
				let peer = peers[connId]
				if (!peer) return false // ignore active call that not in our peer
				call2Connection[call.call_id] = connId
				serverCalls[call.call_id] = call
				return true
			})
		})
	}
	syncCallWithServer()
	env.setInterval(syncCallWithServer, 10000)

	let cleanEndedCall = () => {
		Object.keys(endRequest).map((callid) => {
			if (env.Date.now() - endRequest[callid] > 60000) delete endRequest[callid]
		})

		Object.keys(answerRequest).map((callid) => {
			if (env.Date.now() - endRequest[callid] > 60000) delete answerRequest[callid]
		})

		Object.keys(serverCalls).map((callid) => {
			let call = serverCalls[callid]
			if (!call) return delete serverCalls[callid]
			if (call.status != 'ended') return
			if (env.Date.now() - call.ended > 60000) delete serverCalls[callid]
		})

		Object.keys(call2Connection).map((callid) => {
			let call = this.matchCall(callid)
			if (!call) return delete call2Connection[callid]
			if (call.status != 'ended') return
			if (env.Date.now() - call.ended > 60000) delete call2Connection[callid]
		})
	}
	env.setInterval(cleanEndedCall, 120000)

	let publish = (ev) => {
		if (ev.type == 'call_ended') {
			let callid = ev.data && ev.data.call_info && ev.data.call_info.call_id
			let connId = call2Connection[callid]
			let peer = peers[connId]
			if (peer) {
				delete peers[connId]
				peer.close()
			}
			stopStream(streams[connId])
			// do not clean up this now or some functions cannot work after the call ended
			// DONOT: delete call2Connection[callid]
			delete streams[connId]
		}

		let direction = ev.data && ev.data.call_info && ev.data.call_info.direction
		if (direction == 'incoming') ev.data.call_info.direction = 'inbound'
		if (direction == 'outgoing') ev.data.call_info.direction = 'outbound'
		onEvent && onEvent(ev)
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

			Object.keys(answerRequest).map((callid) => {
				let call = calls[callid]
				if (!call) return
				call.answer_requested = answerRequest[callid]
			})

			Object.values(calls).map((call) => {
				let direction = call && call.direction
				if (direction == 'incoming') call.direction = 'inbound'
				if (direction == 'outgoing') call.direction = 'outbound'
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
		if (direction == 'incoming') call.direction = 'inbound'
		if (direction == 'outgoing') call.direction = 'outbound'

		return call
	}

	realtime.onEvent((ev) => {
		if (!ev || !ev.type || !ev.data) return
		if (env._is_webrtc_local && ev.user_id != '8') return // local
		if (!env._is_webrtc_local && ev.user_id != '9') return // prod

		if (ev.type == 'webrtc_candidate_added') {
			let ice_candidate = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.ice_candidate
			let connId = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.connection_id
			if (!connId) return
			if (!ice_candidate) return
			let peer = peers[connId]

			return waitForRemoteDescription[connId].then(() => peer && peer.addIceCandidate(parseJSON(ice_candidate)))
		}

		if (ev.type == 'webrtc_negotiation_offered') {
			// console.log('RT/RECEIVE OFFERED NEGOTIATION', ev)
			let jsonoffer = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.offer
			let connId = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.connection_id
			let peer = peers[connId]
			if (!peer) return
			let negid = ev.id
			// let negid = ev && ev.data && ev.data.webrtc_message && ev.data.webrtc_message.negotiation_id
			let offer = parseJSON(jsonoffer)
			if (!offer) return

			peer
				.setRemoteDescription(offer)
				.then(() => {
					readyToSendCandidateResolve[connId]()
					let stream = streams[connId]
					stream &&
						stream.getTracks().forEach((track) => {
							let replaced = false
							peer.getSenders().forEach((sender) => {
								if (!sender.track) return
								if (sender.track.kind != track.kind) return
								sender.replaceTrack(track)
								replaced = true
							})
							if (!replaced) peer.addTrack(track, stream)
						})
					return peer.createAnswer()
				})
				.then((answer) =>
					peer.setLocalDescription(answer).then(() => {
						let url = `${apiUrl}finish?x-access-token=${access_token}&connection_id=${connId}&version=2&negotiation_id=${negid}`
						callAPI('post', url, jsonify(answer), function (body, code) {
							if (code !== 200) {
								logError(accid, agid, body, 'finish:295')
								return console.error('CANNOT FINISH', body)
							}
							return
						})
					}),
				)
		}

		let call_info = ev.data.call_info || {}
		let callid = call_info.call_id
		if (!callid) return
		let type = ev.type
		if (type === 'call_invited') {
			if (agid == call_info.from_number) return // ignore our own invite
			serverCalls[callid] = call_info
			return publish(ev)
		}

		if (type == 'call_ended') {
			serverCalls[callid] = call_info
			return publish(ev)
		}

		if (ev.type === 'call_invite_expired') {
			if (Object.keys(peers).find((cid) => cid == call_info.device_id)) return // this call invitation is expired by us => ignore
			serverCalls[callid] = call_info
			publish(Object.assign({}, ev, {type: 'call_ended'})) // fake ended call
			return
		}

		let connId = call_info.device_id
		if (!Object.keys(peers).find((cid) => cid == connId)) return
		if (type == 'call_ringing' || type == 'call_joined') {
			serverCalls[callid] = call_info
			return publish(ev)
		}
	})

	this.makeCall = (number, fromnumber, streamPm, callid, campaignid, outboundcallentryid) => {
		if (!callid) callid = 'webcall-' + randomString(30)
		let now = env.Date.now()
		let call = {
			account_id: accid,
			call_id: callid,
			direction: 'outbound',
			member_id: agid,
			started: now,
			status: 'dialing',
			to_number: number,
			from_number: fromnumber,
		}
		dialingRequest[callid] = call
		publish({created: now, type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			streamPm
				.then((stream) => {
					this.joinCall(callid, stream, (err, connId) => {
						if (err) {
							delete dialingRequest[callid]
							endRequest[callid] = env.Date.now()
							publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
							return rs({error: err})
						}

						let url = `${apiUrl}call?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number=${number}&from_number=${fromnumber}`
						if (outboundcallentryid) url += `&outbound_call_entry_id=${outboundcallentryid}`
						if (campaignid) url += `&campaign_id=${campaignid}`
						callAPI('post', url, undefined, (body, code) => {
							if (code != 200) {
								logError(accid, agid, body, 'makeCall:365')
								delete dialingRequest[callid]
								endRequest[callid] = env.Date.now()
								publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
								return rs({error: err})
							}
							body = parseJSON(body)
							if (body) serverCalls[callid] = body
							delete dialingRequest[callid]
							rs({body})
						})
					})
				})
				.catch((err) => rs({error: err}))
		})
	}

	this.hangupCall = (callid) => {
		if (!callid) return
		endRequest[callid] = env.Date.now()

		let call = serverCalls[callid]
		if (!call) {
			call = {call_id: callid}
			serverCalls[callid] = call
		}
		call.status = 'ended'
		call.ended = env.Date.now()
		publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
		callAPI('post', `${apiUrl}hangup?x-access-token=${access_token}&call_id=${callid}`)
	}

	this.listenCall = (callid, cb) => {
		let start = env.Date.now()
		initSession((err, connId) => {
			let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}`
			callAPI('post', url, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'listenCall:399')
				collect('listen_call', callid, env.Date.now() - start)
				return code != 200 ? cb(body) : cb()
			})
		})
	}

	this.joinCall = (callid, stream, cb) => {
		let start = env.Date.now()
		initSession((err, connId) => {
			call2Connection[callid] = connId
			streams[connId] = stream
			let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&talk=true`
			callAPI('post', url, undefined, (body, code) => {
				if (code != 200) logError(accid, agid, body, 'joinCall:413')
				collect('join_call', callid, env.Date.now() - start)
				if (code != 200) return cb(body, connId)
				checkIceConnected(peers[connId], () => cb(undefined, connId))
			})
		})
	}

	this.answerCall = (callid, stream) => {
		let call = serverCalls[callid]
		if (call && call.status == 'ended') return Promise.resolve({error: 'call_ended'})
		let now = env.Date.now()
		if (answerRequest[callid]) return Promise.resolve({body: call})
		answerRequest[callid] = now
		publish({created: env.Date.now(), type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			this.joinCall(callid, stream, (err, connId) => {
				if (err) {
					delete answerRequest[callid]
					endRequest[callid] = now
					publish({created: env.Date.now(), type: 'call_ended', data: {call_info: {call_id: callid}}})
					return rs({error: err})
				}
				let url = `${apiUrl}answer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}`
				callAPI('post', url, undefined, (body, code) => {
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
			let connId = call2Connection[callid]
			if (!connId) return rs({body: {}})
			let url = `${apiUrl}dtml?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&key={key}`
			initSession(() =>
				callAPI('post', url, undefined, (body, code) => {
					if (code != 200) logError(accid, agid, body, 'sendDtmf:463')
					body = parseJSON(body)
					return code != 200 ? rs({error: body}) : rs({body})
				}),
			)
		})

	this.transferCall = (tonumber, callid) =>
		new env.Promise((rs) => {
			if (!callid) return rs({})
			let connId = call2Connection[callid]
			if (!connId) return rs({body: {}})
			let url = `${apiUrl}refer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number={tonumber}`
			initSession(() =>
				callAPI('post', url, undefined, (body, code) => {
					if (code != 200) logError(accid, agid, body, 'transferCall:478')
					collect('transfer_call', callid, env.Date.now() - start)
					body = parseJSON(body)
					return code != 200 ? rs({error: body}) : rs({body})
				}),
			)
		})
}

module.exports = WebRTCConn
