var flow = require('@subiz/flow')
var {xhrsend} = require('./common.js')
const servers = {
	iceServers: [{urls: ['stun:stun.l.google.com:19302']}],
}

// let connId = 'webrtc' + randomString(20)
// env = {RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, setTimeout, setInterval, jsonify, parseJSON}
// set env._is_webrtc_local to true for local testing
function WebRTCConn(options) {
	let {apiUrl, access_token, accid, agid, connId, realtime, callAPI, env, onTrack, onEvent} = options
	if (!apiUrl) {
		apiUrl = 'https://callcenter.subiz.com.vn/wc/'
		if (env._is_webrtc_local) apiUrl = 'http://localhost:8008/'
	}

	callAPI = callAPI || xhrsend // allow hook
	let callStream = {} // callid => stream

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
	let currentStream
	let pendingStream
	let activeCalls = {}

	let dialingRequest = {}
	let answerRequest = {}
	let endRequest = {}

	let subscribe = realtime.subscribe([
		`webrtc.account.${accid}.agent.${agid}`,
		`webrtc.account.${accid}.agent.${agid}.webrtc_connection.${connId}`,
	])

	let peer
	// makeSure only returns when stream is added and negotiation is finished
	// its safe to call this function multiple times at once
	let makeSure = (cb) => {
		initConnection()
		subscribe.then(cb)
	}

	let checkIceConnected = (cb) =>
		flow.loop(
			() =>
				new env.Promise((rs) => {
					let pass = peer && (peer.iceConnectionState == 'connected' || peer.iceConnectionState == 'completed')
					if (!pass) return env.setTimeout((_) => rs(true), 100) // keep looping util connected
					cb && cb()
					rs(false)
				}),
		)

	let readyToSendCandidateResolve
	let readyToSendCandidate = new env.Promise((rs) => (readyToSendCandidateResolve = rs))

	let initConnection = () => {
		let needConnect =
			!peer ||
			peer.connectionState === 'disconnected' ||
			peer.connectionState === 'closed' ||
			peer.connectionState === 'failed'

		if (!needConnect) return
		peer = new env.RTCPeerConnection(servers)
		let mypeer = peer

		readyToSendCandidate = new env.Promise((rs) => (readyToSendCandidateResolve = rs))
		peer.ontrack = (event) => {
			if (peer != mypeer) return // outdated
			onTrack && onTrack(event)
		}

		peer.onicecandidate = (event) => {
			if (!event.candidate) return
			if (peer != mypeer) return // outdated
			let url = `${apiUrl}ice-candidates?x-access-token=${access_token}&connection_id=${connId}`
			callAPI('post', url, jsonify(event.candidate))
		}

		peer.onnegotiationneeded = (ev) => console.log('NNNEED RE-NEGOTIATION', ev)
		console.log('NEW PERR')
	}

	let stopStream = (stream) => {
		if (!stream) return
		stream.getTracks().forEach((track) => {
			track.stop()
			track.enabled = false
		})
	}

	// auto tear down when byte received is zero
	// use to clear peer when there's no byte sent around 100 seconds
	let receivedBytes = []
	let check = () => {
		let url = `${apiUrl}calls?x-access-token=${access_token}&connection_id=${connId}`
		callAPI('get', url, undefined, function (body, code) {
			if (code == 200) {
				body = parseJSON(body) || []
				let serverCall = {}
				body.map && body.map((call) => (serverCall[call.call_id] = call))

				// not found
				Object.keys(activeCalls).map((callid) => {
					let call = activeCalls[callid]
					if (!serverCall[callid] && call && call.status != 'ended')
						publish({type: 'call_ended', data: {call_info: {hanup_code: 'outdated', call_id: callid}}})
				})
				activeCalls = serverCall
			}

			if (!peer) return
			peer.getStats(null).then((stats) => {
				let statsOutput = ''
				let receivedByte = 0
				stats.forEach((report) => {
					if (report.type === 'inbound-rtp' && report.kind === 'audio') {
						receivedByte += report.bytesReceived || 0
					}
					if (report.type === 'inbound-rtp' && report.kind === 'video') {
						receivedByte += report.bytesReceived || 0
					}
				})
				receivedBytes.push(receivedByte)
				while (receivedBytes.length > 10) receivedBytes.shift()
				let diff = receivedBytes.filter((n) => n != receivedByte)
				if (diff.length == 0 && receivedBytes.length >= 10 && Object.keys(activeCalls).length == 0) {
					// could tear down
					peer.close()
					peer = undefined
				}
			})
		})
	}
	check()
	env.setInterval(check, 30000)

	let publish = (ev) => {
		if (ev.type == 'call_ended') {
			let callid = lo.get(ev, 'data.call_info.call_id')
			stopStream(callStream[callid])
			delete callStream[callid]
		}
		onEvent && onEvent(ev)
	}

	this.matchCall = (callid) => {
		if (!callid || callid == '*' || callid == '-') {
			let calls = Object.assign({}, activeCalls)
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
			return calls
		}

		let call = activeCalls[callid]
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
		return call
	}

	realtime.onEvent((ev) => {
		if (!ev || !ev.type || !ev.data) return
		// if (ev.type.startsWith('call')) console.log('EEEEEEE', ev)
		if (env._is_webrtc_local && ev.user_id != '8') return // local
		if (!env._is_webrtc_local && ev.user_id != '9') return // prod

		if (ev.type == 'webrtc_candidate_added') {
			let ice_candidate = ev.data.ice_candidate
			if (!ice_candidate) return
			return readyToSendCandidate.then(() => peer && peer.addIceCandidate(parseJSON(ice_candidate)))
		}

		if (ev.type == 'webrtc_negotiation_offered') {
			console.log('RT/RECEIVE OFFERED NEGOTIATION', ev)
			if (!peer) return
			let negid = ev.id
			if (!ev.data.ice_candidate) return
			let offer = parseJSON(ev.data.ice_candidate)

			peer
				.setRemoteDescription(offer)
				.then(() => {
					readyToSendCandidateResolve()
					if (pendingStream && pendingStream != currentStream) {
						currentStream = pendingStream
						currentStream.getTracks().forEach((track) => peer.addTrack(track, currentStream))
					}
					pendingStream = undefined
					return peer.createAnswer()
				})
				.then((answer) =>
					peer.setLocalDescription(answer).then(() => {
						let url = `${apiUrl}finish?x-access-token=${access_token}&connection_id=${connId}&version=2&negotiation_id=${negid}`
						callAPI('post', url, jsonify(answer), function (body, code) {
							if (code !== 200) return console.error('CANNOT FINISH', body)
							return
						})
					}),
				)
		}

		let call_info = ev.data.call_info || {}
		let callid = call_info.call_id
		if (!callid) return

		if (ev.type === 'call_invite_expired') {
			let device_id = call_info.device_id
			if (device_id == connId) return // ignore since we have accepted the call
			publish(Object.assign({}, ev, {type: 'call_ended'})) // fake ended call
			delete activeCalls[callid]
		}

		let type = ev.type
		if (type == 'call_ended' || type == 'call_ringing' || type == 'call_joined' || type === 'call_invited') {
			if (ev.type === 'call_invited' && agid == call_info.from_number) return // ignore our own invite
			activeCalls[callid] = call_info
			return publish(ev)
		}
	})

	this.makeCall = (number, fromnumber, stream, callid) => {
		if (!callid) callid = 'webcall-' + randomString(30)
		let now = env.Date.now()
		let call = {
			account_id: accid,
			call_id: callid,
			device_id: connId,
			direction: 'outbound',
			member_id: agid,
			started: now,
			status: 'dialing',
			to_number: number,
		}
		dialingRequest[callid] = call
		publish({type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			this.joinCall(callid, stream, (err) => {
				if (err) {
					delete dialingRequest[callid]
					endRequest[callid] = env.Date.now()
					publish({type: 'call_ended', data: {call_info: {call_id: callid}}})
					return rs({error: err})
				}

				let url = `${apiUrl}call?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number=${number}&from_number=${fromnumber}`
				callAPI('post', url, undefined, (body, code) => {
					if (code != 200) {
						delete dialingRequest[callid]
						endRequest[callid] = env.Date.now()
						publish({type: 'call_ended', data: {call_info: {call_id: callid}}})
						return rs({error: err})
					}
					body = parseJSON(body)
					if (body) activeCalls[callid] = body
					rs({body})
				})
			})
		})
	}

	this.hangupCall = (callid) => {
		if (!callid) return
		endRequest[callid] = env.Date.now()

		let call = activeCalls[callid]
		if (!call) {
			call = {call_id: callid}
			activeCalls[callid] = call
		}
		call.status = 'ended'
		call.ended = env.Date.now()
		publish({type: 'call_ended', data: {call_info: {call_id: callid}}})

		callAPI('post', `${apiUrl}hangup?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}`)
	}

	this.listenCall = (callid, cb) => {
		let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}`
		makeSure(() => callAPI('post', url, undefined, (body, code) => (code != 200 ? cb(body) : cb())))
	}

	this.joinCall = (callid, stream, cb) => {
		callStream[callid] = stream
		console.time('makecall' + callid)
		makeSure(() => {
			pendingStream = stream
			let url = `${apiUrl}listen?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&talk=true`
			callAPI('post', url, undefined, (body, code) => {
				if (code != 200) return cb(body)
				console.timeEnd('makecall' + callid)
				if (code != 200) return cb(body)
				checkIceConnected(() => cb())
			})
		})
	}

	this.answerCall = (callid, stream) => {
		let call = activeCalls[callid]
		if (call && call.status == 'ended') return Promise.resolve({error: 'call_ended'})
		let now = env.Date.now()
		if (answerRequest[callid]) return Promise.resolve({body: call})
		answerRequest[callid] = now
		publish({type: 'call_ringing', data: {call_info: {call_id: callid}}}) // fake dialing
		return new env.Promise((rs) => {
			this.joinCall(callid, stream, (err) => {
				if (err) {
					delete answerRequest[callid]
					endRequest[callid] = now
					publish({type: 'call_ended', data: {call_info: {call_id: callid}}})
					return rs({error: err})
				}
				let url = `${apiUrl}answer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}`
				callAPI('post', url, undefined, (body, code) => {
					body = parseJSON(body)
					if (code != 200) {
						delete answerRequest[callid]
						endRequest[callid] = now
						publish({type: 'call_ended', data: {call_info: {call_id: callid}}})
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
			let url = `${apiUrl}dtml?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&key={key}`
			makeSure(() =>
				callAPI('post', url, undefined, (body, bode) => {
					body = parseJSON(body)
					return code != 200 ? rs({error: body}) : rs({body})
				}),
			)
		})

	this.transferCall = (tonumber, callid) =>
		new env.Promise((rs) => {
			if (!callid) return rs({})
			let url = `${apiUrl}refer?x-access-token=${access_token}&connection_id=${connId}&call_id=${callid}&number={tonumber}`
			makeSure(() =>
				callAPI('post', url, undefined, (body, code) => {
					body = parseJSON(body)
					return code != 200 ? rs({error: body}) : rs({body})
				}),
			)
		})
}

function randomString(len) {
	var str = ''
	if (!len || len < 1) len = 10
	var asciiKey
	for (var i = 0; i < len; i++) {
		asciiKey = Math.floor(Math.random() * 25 + 97)
		str += String.fromCharCode(asciiKey)
	}
	return str
}

module.exports = WebRTCConn
