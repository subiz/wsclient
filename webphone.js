var {xhrsend, parseJSON, Pubsub, randomString, reportCallbackError} = require('./common.js')
const WebRTCConn = require('./webrtc.js')
var Realtime = require('./realtime.js')

function WebPhone(access_token, realtime) {
	var pubsub = new Pubsub(reportCallbackError)

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
		realtime = new Realtime(
			'https://api.subiz.com.vn/rt/0/',
			{
				getAccessToken: function () {
					return new Promise(function (rs) {
						rs(access_token)
					})
				},
			},
			undefined,
			accid,
		)

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
			if (!$audio) return
			$audio.srcObject = event.streams[0]
		},
	})

	var _numbers = []
	var _fetchNumbers = function () {
		xhrsend(
			'get',
			`https://api.subiz.com.vn/4.0/integrations?x-access-token=${access_token}`,
			undefined,
			function (body, code) {
				setTimeout(_fetchNumbers, 120000)
				if (code != 200) return
				var integrations = parseJSON(body)
				if (!integrations || !integrations.length) return
				var numbers = []
				for (var i = 0; i < integrations.length; i++) {
					var integration = integrations[i] || {}
					if (integration.connector_type == 'call' && integration.state == 'activated') {
						var number = integration.id.split('.')[1]
						numbers.push(number)
					}
				}
				_numbers = numbers
			},
		)
	}
	_fetchNumbers()

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
		return me.checkMic().result.then(function (stream) {
			return !!stream
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
			result: microPermission,
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
		current_call_id = callid
		return webrtcconn.answerCall(callid, getMicroPermissions()).then(function (out) {
			return out.error ? {error: out.error} : out.body
		})
	}

	this.getCall = function (callid) {
		return webrtcconn.matchCall(callid)
	}

	var base = '0123456789abcdef'
	// makeCall(number, [] || undefined || '', streamPm) // fallback all number
	// makeCall(number, ['a','b','c'], streamPm) // fallback specific number
	// makeCall(number, function() {}, streamPm) //
	this.makeCall = function (number, fromnumbers, streamPm, _a, _b, _state) {
		var ownsSource = !_state
		if (!_state) _state = {}
		if (!fromnumbers || (Array.isArray(fromnumbers) && fromnumbers.length == 0)) {
			fromnumbers = _numbers
		}

		if (typeof fromnumbers === 'string' || fromnumbers instanceof String || typeof fromnumbers === 'number') {
			fromnumbers = [fromnumbers + '']
		}

		// '11edc52b-2918-4d71-9058-f7285e29d894'
		var callid = `${randomString(8, base)}-${randomString(4, base)}-${randomString(4, base)}`
		callid += `-${randomString(4, base)}-${randomString(12, base)}`
		current_call_id = callid

		let callnumber = chooseCallNumber(fromnumbers, _state.called)
		if (!callnumber)
			return Promise.resolve(
				_state.last_result || {
					start: Date.now(),
					ended: Date.now(),
					direction: 'outbound',
					account_id: accid,
					to_number: number,
					error: 'out_of_number',
					id: callid,
					hangup_code: 'failure',
					status: 'ended',
				},
			)
		// Each attempt owns its clone. The source stays live across number fallback
		// and is released once the complete dialing sequence finishes.
		if (!_state.source) _state.source = Promise.resolve(streamPm || getMicroPermissions())
		var attemptStream = _state.source.then((stream) => stream && stream.clone())
		var result = webrtcconn.makeCall(number, callnumber, attemptStream, callid).then((out) => {
			if (out.error) return out
			if (out.hangup_code == 'cancel') return out
			if (out.answered > 0) return out

			if (out.hangup_code == 'terminated' || out.hangup_code == 'failure' || out.hangup_code == 'congestion') {
				if (!_state.called) _state.called = {}
				_state.called[callnumber] = true
				_state.last_result = out
				return me.makeCall(number, fromnumbers, streamPm, _a, _b, _state)
			}
			return out
		})
		if (!ownsSource) return result
		return result.finally(() => {
			_state.source
				.then((stream) => {
					if (stream) stream.getTracks().forEach((track) => track.stop())
				}, reportCallbackError)
				.catch(reportCallbackError)
		})
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

function chooseCallNumber(numbers, called) {
	if (!called) called = {}
	if (!numbers || !numbers.length) return ''
	for (var i = 0; i < numbers.length; i++) {
		var number = numbers[i]
		if (called[number]) continue
		return number
	}
	return ''
}
