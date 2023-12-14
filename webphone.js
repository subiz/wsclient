var {xhrsend, parseJSON, Pubsub, randomString} = require('./common.js')
const WebRTCConn = require('./webrtc.js')
var Realtime = require('./realtime.js')

function WebPhone(access_token, realtime) {
	var pubsub = new Pubsub()

	var $audio = null
	// chuẩn bị thẻ audio để nghe được
	function createAudioTag() {
		if ($audio) return
		if (!document.createElement) return // mobile

		$audio = document.createElement('audio')
		$audio.id = 'web_call_audio'
		$audio.style = 'display: none'
		$audio.autoplay = 'autoplay'
		document.body.appendChild($audio)
	}

	createAudioTag()

	access_token = access_token || ''
	if (!access_token) throw 'invalid_access_token'
	var accid = access_token.split('_')[0]
	if (!accid.startsWith('ac')) throw 'invalid_access_token'
	var agid = access_token.split('_')[1]
	if (!agid.startsWith('ag')) throw 'invalid_access_token'

	if (!realtime)
		realtime = new Realtime('https://api.subiz.com.vn/rt/0/', {
			getAccessToken: function () {
				return new Promise(function (rs) {
					rs(access_token)
				})
			},
		})

	var webrtcconn = new WebRTCConn({
		accid: accid,
		agid: agid,
		access_token: access_token,
		realtime,
		env: window,
		onEvent: function (ev) {
			// publish call status event
			if (!(ev.type || '').startsWith('call')) return
			if (!ev.data || !ev.data.call_info) return
			let callid = ev.data.call_info.call_id
			if (!callid) return
			pubsub.emit('event', ev)
		},
		onTrack: function (event) {
			if (event.track.kind != 'audio') return
			$audio.srcObject = event.streams[0]
		},
	})

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.sendDtmf = function (key, callid) {
		return webrtcconn.sendDtmf(key, callid)
	}

	this.transferCall = function (number, callid) {
		return webrtcconn.transferCall(number, callid)
	}

	this.hangupCall = function (callid) {
		if (!callid) callid = current_call_id
		return webrtcconn.hangupCall(callid)
	}

	var me = this
	this.isMicAllowed = function () {
		return me.checkMic().then(function (out) {
			return out.result
		})
	}

	var micStream = undefined
	this.getMicroStream = function () {
		return micStream
	}

	this.checkMic = function () {
		const timeout = new Promise(function (rs, rj) {
			return setTimeout(rs, 500, 'Not_authorized')
		})
		var microPermission = getMicroPermissions()
		return {
			timeout: Promise.race([timeout, microPermission]),
			result: getMicroPermissions(),
		}
	}

	var getMicroPermissions = function () {
		return new Promise(function (rs) {
			navigator.mediaDevices
				.getUserMedia({audio: true, video: false})
				.then(function (stream) {
					micStream = stream
					rs(micStream)
				})
				.catch(function (err) {
					console.log('REJECT VIDEO PERMISSSIONN', err)
					micStream = undefined
					rs(undefined)
				})
		})
	}

	this.answerWebCall = function (callid) {
		return new Promise(function (rs) {
			getMicroPermissions().then(function (stream) {
				current_call_id = callid
				webrtcconn.answerCall(callid, stream).then(function (out) {
					if (out.error) return rs({error})
					rs(body)
				})
			})
		})
	}

	this.getCall = function (callid) {
		return webrtcconn.matchCall(callid)
	}

	var base = '0123456789abcdef'
	this.makeCall = function (number, fromnumber, streamPm) {
		// '11edc52b-2918-4d71-9058-f7285e29d894'
		var callid =
			randomString(8, base) +
			'-' +
			randomString(4, base) +
			'-' +
			randomString(4, base) +
			'-' +
			randomString(4, base) +
			'-' +
			randomString(12, base)

		current_call_id = callid

		if (!streamPm) streamPm = getMicroPermissions()
		return webrtcconn.makeCall(number, fromnumber, streamPm, callid)
	}

	var current_call_id = ''
	this.getCurrentCallId = function () {
		return current_call_id
	}

	this.getCurrentCall = function () {
		if (current_call_id) {
			var call = webrtcconn.matchCall(current_call_id)
			if (call && call.status != 'ended') return call
		}

		var myOutgoingCall = Object.values(webrtcconn.matchCall()).find(function (call) {
			var isOutboundCall = call.direction == 'outbound' || call.direction == 'outgoing'
			return (call.status == 'dialing' || call.status == 'active') && isOutboundCall
		})
		if (myOutgoingCall) {
			current_call_id = myOutgoingCall.call_id || ''
			return myOutgoingCall
		}

		var dialingIncomingCall = Object.values(webrtcconn.matchCall()).find(function (call) {
			return call.status == 'dialing' && (call.direction == 'incoming' || call.direction == 'inbound')
		})
		if (dialingIncomingCall) {
			current_call_id = dialingIncomingCall.call_id || ''
			return dialingIncomingCall
		}

		current_call_id = ''
		return undefined
	}
}

window.SbzWebPhone1 = WebPhone
module.exports = WebPhone
