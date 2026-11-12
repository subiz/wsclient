const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs'),
	vm = require('node:vm'),
	assert = require('node:assert/strict')
const {createRequire} = require('node:module')
const requireWS = createRequire(path.join(__dirname, 'webrtc.js'))
function environment({connected = false, throwEnded = false, subscribe, setupTimeoutMs} = {}) {
	let now = 100000,
		id = 0,
		seq = 0,
		micCalls = 0
	const timers = new Map(),
		peers = [],
		requests = [],
		events = [],
		listeners = [],
		tracks = [],
		errors = []
	const consoleMock = {info() {}, warn() {}, error() {}, log() {}}
	const schedule = (fn, ms, repeat, args) => {
		const tid = ++id
		timers.set(tid, {fn, at: now + ms, repeat, args})
		return tid
	}
	class Peer {
		constructor() {
			this.connectionState = connected ? 'connected' : 'new'
			this.iceConnectionState = connected ? 'connected' : 'new'
			this.signalingState = 'stable'
			this.senders = []
			peers.push(this)
		}
		getSenders() {
			return this.senders
		}
		getReceivers() {
			return []
		}
		getTransceivers() {
			return []
		}
		close() {
			this.connectionState = this.iceConnectionState = this.signalingState = 'closed'
		}
		addTrack(track) {
			this.senders.push({
				track,
				replaceTrack(t) {
					this.track = t
					return Promise.resolve()
				},
			})
		}
		setRemoteDescription() {
			return Promise.resolve()
		}
		createAnswer() {
			return Promise.resolve({type: 'answer', sdp: 'test'})
		}
		setLocalDescription() {
			return Promise.resolve()
		}
		addIceCandidate() {
			return Promise.resolve()
		}
	}
	function stream() {
		const track = {
			kind: 'audio',
			readyState: 'live',
			enabled: true,
			stop() {
				this.readyState = 'ended'
				this.stops = (this.stops || 0) + 1
			},
		}
		tracks.push(track)
		return {getTracks: () => [track], getAudioTracks: () => [track], clone: () => stream()}
	}
	const env = {
		Promise,
		JSON,
		Date: class extends Date {
			static now() {
				return now
			}
		},
		RTCPeerConnection: Peer,
		setTimeout: (fn, ms, ...args) => schedule(fn, ms, 0, args),
		clearTimeout: (id) => timers.delete(id),
		setInterval: (fn, ms, ...args) => schedule(fn, ms, ms, args),
		clearInterval: (id) => timers.delete(id),
		document: {
			createElement() {
				return {}
			},
			body: {appendChild() {}},
		},
		navigator: {
			mediaDevices: {
				getUserMedia() {
					micCalls++
					return Promise.resolve(stream())
				},
			},
		},
	}
	const transport = (method, url, body, cb) => {
		const req = {method, url, body, cb}
		requests.push(req)
		return {
			abort() {
				req.aborted = true
			},
		}
	}
	const rt = {
		subscribe(topics) {
			return subscribe ? subscribe(topics) : Promise.resolve({})
		},
		onEvent(cb) {
			listeners.push(cb)
		},
	}
	const realCommon = requireWS('./common.js')
	const common = {
		...realCommon,
		reportCallbackError(err) {
			errors.push(err)
		},
		xhrsend: transport,
		randomString: () => String(++seq).padStart(20, 'a'),
	}
	const ctx = {
		module: {exports: {}},
		console: consoleMock,
		require: (name) => (name === './common.js' ? common : requireWS(name)),
	}
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8'), ctx)
	const WebRTC = ctx.module.exports
	const rtc = new WebRTC({
		setupTimeoutMs,
		env,
		accid: 'ac-test',
		agid: 'ag-test',
		access_token: 'ac-test_ag-test_secret',
		realtime: rt,
		callAPI: transport,
		onEvent(ev) {
			events.push(ev)
			if (throwEnded && ev.type === 'call_ended') throw Error('consumer error')
		},
	})
	async function flush() {
		for (let i = 0; i < 40; i++) await Promise.resolve()
	}
	async function tick(ms) {
		await flush()
		let end = now + ms
		for (let n = 0; n < 20000; n++) {
			let next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
			if (!next) {
				now = end
				await flush()
				return
			}
			let [tid, t] = next
			now = t.at
			if (t.repeat) t.at += t.repeat
			else timers.delete(tid)
			t.fn(...t.args)
			await flush()
		}
		throw Error('timer limit')
	}
	function take(path) {
		const req = requests.find((r) => !r.taken && new URL(r.url).pathname.endsWith('/' + path))
		assert.ok(req, 'missing ' + path)
		req.taken = true
		return req
	}
	function emit(ev) {
		for (const cb of listeners) cb(ev)
	}
	function phone() {
		const context = {
			...env,
			window: env,
			document: env.document,
			navigator: env.navigator,
			console: consoleMock,
			module: {exports: {}},
			require(name) {
				if (name === './common.js') return common
				if (name === './webrtc.js') return WebRTC
				if (name === './realtime.js')
					return function () {
						return rt
					}
				throw Error(name)
			},
		}
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'webphone.js'), 'utf8'), context)
		return new context.module.exports('ac-test_ag-test_secret', rt)
	}
	return {
		rtc,
		rt,
		env,
		peers,
		requests,
		events,
		tracks,
		errors,
		stream,
		flush,
		tick,
		take,
		emit,
		phone,
		micCalls: () => micCalls,
		timerCount: () => timers.size,
	}
}

function ended(h, request, code = 'normal') {
	const callid = new URL(request.url).searchParams.get('call_id')
	h.emit({
		type: 'call_ended',
		data: {call_info: {call_id: callid, status: 'ended', hangup_code: code, ended: h.env.Date.now()}},
	})
}

test('late response from replaced join cannot close the new connection', async () => {
	const h = environment({connected: true}),
		results = []
	h.rtc.joinCall('same', h.stream(), (err) => results.push(['old', err]))
	await h.flush()
	const old = h.take('listen')
	h.rtc.joinCall('same', h.stream(), (err) => results.push(['new', err]))
	await h.flush()
	const current = h.take('listen')
	assert.equal(old.aborted, true)
	old.cb('{}', 200)
	await h.flush()
	assert.equal(h.peers[1].connectionState, 'connected')
	assert.deepEqual(results, [['old', 'replaced']])
	current.cb('{}', 200)
	await h.flush()
	assert.deepEqual(results, [
		['old', 'replaced'],
		['new', undefined],
	])
	h.rtc.shutdown()
})

test('replaced ICE waiter does not close the new peer', async () => {
	const h = environment(),
		results = []
	h.rtc.joinCall('same', h.stream(), (err) => results.push(err))
	await h.flush()
	h.take('listen').cb('{}', 200)
	await h.flush()
	h.rtc.joinCall('same', h.stream(), (err) => results.push(err))
	await h.tick(200)
	assert.deepEqual(results, ['replaced'])
	assert.equal(h.peers[1].connectionState, 'new')
	assert.equal(h.rtc.debugState().sessions.same.peer, true)
	h.rtc.shutdown()
	await h.flush()
	assert.equal(h.timerCount(), 0)
})

for (const stage of ['microphone', 'subscribe', 'listen', 'ice', 'call']) {
	test('setup deadline covers ' + stage + ' and ignores late completion', async () => {
		let resolveMic, resolveSub
		const h = environment({
			connected: stage === 'call',
			subscribe(topics) {
				if (stage === 'subscribe' && topics[0].includes('webrtc_connection'))
					return new Promise((r) => {
						resolveSub = r
					})
				return Promise.resolve({})
			},
		})
		const source = h.stream()
		const streamPm =
			stage === 'microphone'
				? new Promise((r) => {
						resolveMic = r
					})
				: Promise.resolve(source)
		const result = h.rtc.makeCall('to', 'from', streamPm, 'deadline')
		await h.flush()
		let request
		if (stage === 'listen' || stage === 'ice' || stage === 'call') request = h.take('listen')
		if (stage === 'ice' || stage === 'call') {
			request.cb('{}', 200)
			await h.flush()
		}
		if (stage === 'call') request = h.take('call')
		await h.tick(60000)
		assert.equal((await result).error, 'setup_timeout')
		if (stage === 'listen' || stage === 'call') assert.equal(request.aborted, true)
		if (resolveMic) resolveMic(source)
		if (resolveSub) resolveSub({})
		if (request) request.cb('{}', 200)
		await h.flush()
		assert.equal(source.getTracks()[0].readyState, 'ended')
		assert.equal(Object.keys(h.rtc.debugState().sessions).length, 0)
		assert.equal(h.rtc.matchCall('deadline').status, 'ended')
		const count = h.requests.length
		await h.tick(180000)
		assert.equal(h.requests.length, count)
		h.rtc.shutdown()
		assert.equal(h.timerCount(), 0)
	})
}

test('setup budget is shared across stages', async () => {
	const h = environment({connected: true})
	let resolveMic
	const result = h.rtc.makeCall(
		'to',
		'from',
		new Promise((r) => {
			resolveMic = r
		}),
		'budget',
	)
	await h.tick(30000)
	resolveMic(h.stream())
	await h.flush()
	const listen = h.take('listen')
	await h.tick(25000)
	listen.cb('{}', 200)
	await h.flush()
	const call = h.take('call')
	await h.tick(5000)
	assert.equal((await result).error, 'setup_timeout')
	assert.equal(call.aborted, true)
	h.rtc.shutdown()
})

test('successful outbound setup cancels deadline but still resolves on hangup', async () => {
	const h = environment({connected: true})
	let settled = false
	const result = h.rtc.makeCall('to', 'from', Promise.resolve(h.stream()), 'long-call').then((out) => {
		settled = true
		return out
	})
	await h.flush()
	h.take('listen').cb('{}', 200)
	await h.flush()
	const call = h.take('call')
	call.cb('{}', 200)
	await h.tick(180000)
	assert.equal(settled, false)
	assert.equal(h.peers[0].connectionState, 'connected')
	ended(h, call)
	assert.equal((await result).status, 'ended')
	assert.equal(h.peers[0].connectionState, 'closed')
	h.rtc.shutdown()
})

for (const stage of ['microphone', 'subscribe', 'listen', 'ice', 'call', 'active']) {
	test('shutdown settles ' + stage + ' and suppresses late work', async () => {
		let resolveMic, resolveSub
		const h = environment({
			connected: stage === 'call' || stage === 'active',
			subscribe(topics) {
				if (stage === 'subscribe' && topics[0].includes('webrtc_connection'))
					return new Promise((r) => {
						resolveSub = r
					})
				return Promise.resolve({})
			},
		})
		const source = h.stream()
		const result = h.rtc.makeCall(
			'to',
			'from',
			stage === 'microphone'
				? new Promise((r) => {
						resolveMic = r
					})
				: Promise.resolve(source),
			'shutdown',
		)
		await h.flush()
		let request
		if (!['microphone', 'subscribe'].includes(stage)) request = h.take('listen')
		if (['ice', 'call', 'active'].includes(stage)) {
			request.cb('{}', 200)
			await h.flush()
		}
		if (['call', 'active'].includes(stage)) request = h.take('call')
		if (stage === 'active') {
			request.cb('{}', 200)
			await h.flush()
		}
		h.rtc.shutdown()
		assert.equal((await result).error, 'shutdown')
		const count = h.requests.length
		if (resolveMic) resolveMic(source)
		if (resolveSub) resolveSub({})
		if (request) request.cb('{}', 200)
		await h.tick(180000)
		assert.equal(h.requests.length, count)
		assert.equal(source.getTracks()[0].readyState, 'ended')
		assert.equal(h.timerCount(), 0)
		assert.equal(Object.keys(h.rtc.debugState().sessions).length, 0)
	})
}

test('answer request has a deadline and cannot restore a canceled call', async () => {
	const h = environment({connected: true})
	const result = h.rtc.answerCall('answer', h.stream())
	await h.flush()
	h.take('listen').cb('{}', 200)
	await h.flush()
	const answer = h.take('answer')
	await h.tick(60000)
	assert.equal((await result).error, 'setup_timeout')
	assert.equal(answer.aborted, true)
	answer.cb('{}', 200)
	await h.flush()
	assert.equal(h.peers[0].connectionState, 'closed')
	h.rtc.shutdown()
})

test('throwing call-ended callback cannot suppress server hangup', async () => {
	const h = environment({throwEnded: true})
	h.rtc.joinCall('hangup', h.stream(), () => {})
	await h.flush()
	assert.doesNotThrow(() => h.rtc.hangupCall('hangup'))
	assert.ok(h.take('hangup'))
	assert.equal(h.errors.length, 1)
	assert.equal(h.peers[0].connectionState, 'closed')
	h.rtc.shutdown()
	await h.flush()
})

for (const supplied of [false, true]) {
	test('number fallback uses fresh live clones and releases source: supplied=' + supplied, async () => {
		const h = environment({connected: true}),
			phone = h.phone()
		const source = supplied ? h.stream() : undefined
		const result = phone.makeCall('to', ['first', 'second'], source && Promise.resolve(source))
		await h.flush()
		h.take('listen').cb('{}', 200)
		await h.flush()
		const first = h.take('call')
		first.cb('{}', 200)
		await h.flush()
		ended(h, first, 'failure')
		await h.flush()
		assert.equal(h.tracks[0].readyState, 'live', 'source survives first attempt')
		assert.equal(h.tracks[1].readyState, 'ended', 'first clone is released')
		const next = h.take('listen')
		const connid = new URL(next.url).searchParams.get('connection_id')
		h.emit({
			id: 'offer',
			type: 'webrtc_negotiation_offered',
			data: {webrtc_message: {connection_id: connid, offer: JSON.stringify({type: 'offer', sdp: 'test'})}},
		})
		await h.flush()
		assert.equal(h.peers[1].senders[0].track.readyState, 'live')
		next.cb('{}', 200)
		await h.flush()
		const second = h.take('call')
		assert.equal(new URL(second.url).searchParams.get('from_number'), 'second')
		second.cb('{}', 200)
		await h.flush()
		ended(h, second)
		assert.equal((await result).status, 'ended')
		await h.flush()
		assert.equal(h.micCalls(), supplied ? 0 : 1)
		assert.ok(h.tracks.every((track) => track.readyState === 'ended'))
	})
}

test('WebPhone isolates throwing and rejecting listeners', async () => {
	const h = environment(),
		phone = h.phone()
	let received = 0
	phone.onEvent(() => {
		throw Error('consumer')
	})
	phone.onEvent(async () => {
		throw Error('async consumer')
	})
	phone.onEvent(() => received++)
	h.emit({type: 'call_invited', data: {call_info: {call_id: 'invite'}}})
	await h.flush()
	assert.equal(received, 1)
	assert.equal(h.errors.length, 2)
})

test('hangup during permission prompt resolves immediately and stops late microphone', async () => {
	const h = environment()
	let resolveMic
	const result = h.rtc.makeCall(
		'to',
		'from',
		new Promise((r) => {
			resolveMic = r
		}),
		'cancel',
	)
	h.rtc.hangupCall('cancel')
	assert.equal((await result).hangup_code, 'cancel')
	const source = h.stream()
	resolveMic(source)
	await h.flush()
	assert.equal(h.peers.length, 0)
	assert.equal(source.getTracks()[0].readyState, 'ended')
	h.rtc.shutdown()
})

test('new operation supersedes an older unresolved microphone prompt for the same call', async () => {
	const h = environment({connected: true})
	let resolveMic
	const old = h.rtc.makeCall(
		'to',
		'from',
		new Promise((r) => {
			resolveMic = r
		}),
		'same',
	)
	let joined = false
	h.rtc.joinCall('same', h.stream(), (err) => {
		joined = !err
	})
	await h.flush()
	assert.equal((await old).error, 'replaced')
	h.take('listen').cb('{}', 200)
	await h.flush()
	const late = h.stream()
	resolveMic(late)
	await h.flush()
	assert.equal(joined, true)
	assert.equal(h.peers.length, 1)
	assert.equal(h.peers[0].connectionState, 'connected')
	assert.equal(late.getTracks()[0].readyState, 'ended')
	h.rtc.shutdown()
})

test('successful answer retains media after setup deadline and cleans up on end', async () => {
	const h = environment({connected: true})
	const result = h.rtc.answerCall('incoming', h.stream())
	await h.flush()
	h.take('listen').cb('{}', 200)
	await h.flush()
	const answer = h.take('answer')
	answer.cb('{"accepted":true}', 200)
	assert.equal((await result).body.accepted, true)
	await h.tick(180000)
	assert.equal(h.peers[0].connectionState, 'connected')
	ended(h, answer)
	assert.equal(h.peers[0].connectionState, 'closed')
	h.rtc.shutdown()
})

test('pinned-host failure falls back once and hangup uses the retained host', async () => {
	const h = environment({connected: true})
	const result = h.rtc.makeCall('to', 'from', Promise.resolve(h.stream()), 'pin')
	await h.flush()
	h.take('listen').cb('{"api_url":"https://node.subiz.com.vn/wc/"}', 200)
	await h.flush()
	const pinned = h.take('call')
	assert.equal(new URL(pinned.url).hostname, 'node.subiz.com.vn')
	pinned.cb('offline', -1)
	await h.flush()
	const fallback = h.take('call')
	assert.equal(new URL(fallback.url).hostname, 'callcenter.subiz.com.vn')
	fallback.cb('{"api_url":"https://node.subiz.com.vn/wc/"}', 200)
	await h.flush()
	h.rtc.hangupCall('pin')
	assert.equal((await result).hangup_code, 'cancel')
	assert.equal(new URL(h.take('hangup').url).hostname, 'node.subiz.com.vn')
	h.rtc.shutdown()
})

test('shutdown during local SDP creation prevents late finish request', async () => {
	const h = environment()
	h.rtc.joinCall('sdp', h.stream(), () => {})
	await h.flush()
	const listen = h.take('listen')
	let finishSDP
	h.peers[0].setLocalDescription = () =>
		new Promise((r) => {
			finishSDP = r
		})
	h.emit({
		id: 'offer',
		type: 'webrtc_negotiation_offered',
		data: {
			webrtc_message: {
				connection_id: new URL(listen.url).searchParams.get('connection_id'),
				offer: JSON.stringify({type: 'offer', sdp: 'test'}),
			},
		},
	})
	await h.flush()
	assert.equal(typeof finishSDP, 'function')
	h.rtc.shutdown()
	const count = h.requests.length
	finishSDP()
	await h.flush()
	assert.equal(h.requests.length, count)
	assert.equal(h.timerCount(), 0)
})

test('replacement during local SDP creation prevents old finish on the new session', async () => {
	const h = environment()
	h.rtc.joinCall('sdp', h.stream(), () => {})
	await h.flush()
	const old = h.take('listen')
	let finishSDP
	h.peers[0].setLocalDescription = () =>
		new Promise((r) => {
			finishSDP = r
		})
	h.emit({
		id: 'offer',
		type: 'webrtc_negotiation_offered',
		data: {
			webrtc_message: {
				connection_id: new URL(old.url).searchParams.get('connection_id'),
				offer: JSON.stringify({type: 'offer', sdp: 'test'}),
			},
		},
	})
	await h.flush()
	h.rtc.joinCall('sdp', h.stream(), () => {})
	await h.flush()
	const count = h.requests.length
	finishSDP()
	await h.flush()
	assert.equal(h.requests.length, count)
	assert.equal(h.peers[1].connectionState, 'new')
	h.rtc.shutdown()
})

test('WebPhone releases microphone resolving after a setup timeout', async () => {
	const h = environment(),
		phone = h.phone()
	let resolveMic
	const result = phone.makeCall(
		'to',
		['first'],
		new Promise((r) => {
			resolveMic = r
		}),
	)
	await h.tick(60000)
	assert.equal((await result).error, 'setup_timeout')
	resolveMic(h.stream())
	await h.flush()
	assert.ok(h.tracks.every((track) => track.readyState === 'ended'))
	assert.equal(h.peers.length, 0)
})

test('null microphone rejection returns a structured error and cleans state', async () => {
	const h = environment()
	const result = await h.rtc.makeCall('to', 'from', Promise.reject(null), 'rejected')
	assert.equal(result.error, 'setup_failed')
	assert.equal(h.rtc.matchCall('rejected').status, 'ended')
	h.rtc.shutdown()
})

test('WebPhone answer deadline includes microphone permission and stops the late stream', async () => {
	const h = environment(),
		phone = h.phone()
	let resolveMic
	h.env.navigator.mediaDevices.getUserMedia = () =>
		new Promise((r) => {
			resolveMic = r
		})
	const result = phone.answerWebCall('incoming')
	await h.tick(60000)
	assert.equal((await result).error, 'setup_timeout')
	const source = h.stream()
	resolveMic(source)
	await h.flush()
	assert.equal(source.getTracks()[0].readyState, 'ended')
	assert.equal(h.peers.length, 0)
})

test('default WebPhone hangup works while incoming microphone permission is pending', async () => {
	const h = environment(),
		phone = h.phone()
	let resolveMic
	h.env.navigator.mediaDevices.getUserMedia = () =>
		new Promise((r) => {
			resolveMic = r
		})
	const result = phone.answerWebCall('incoming')
	phone.hangupCall()
	assert.equal((await result).hangup_code, 'cancel')
	assert.equal(new URL(h.take('hangup').url).searchParams.get('call_id'), 'incoming')
	const source = h.stream()
	resolveMic(source)
	await h.flush()
	assert.equal(source.getTracks()[0].readyState, 'ended')
})

test('listen callback fires once after ICE is ready, or once on timeout', async () => {
	for (const connected of [false, true]) {
		const h = environment({connected}),
			results = []
		h.rtc.listenCall('monitor', (err) => results.push(err))
		await h.flush()
		h.take('listen').cb('{}', 200)
		await h.tick(60000)
		assert.deepEqual(results, [connected ? undefined : 'setup_timeout'])
		h.rtc.shutdown()
		await h.flush()
		assert.equal(h.timerCount(), 0)
	}
})

test('new setup attempts after shutdown return shutdown and release supplied media', async () => {
	const h = environment()
	h.rtc.shutdown()
	const source = h.stream()
	assert.equal((await h.rtc.makeCall('to', 'from', Promise.resolve(source), 'late')).error, 'shutdown')
	assert.equal((await h.rtc.answerCall('late', Promise.resolve(source))).error, 'shutdown')
	let joined
	await h.rtc.joinCall('late', source, (err) => {
		joined = err
	})
	assert.equal(joined, 'shutdown')
	assert.equal(source.getTracks()[0].readyState, 'ended')
	assert.equal(h.peers.length, 0)
	assert.equal(h.requests.length, 0)
	assert.equal(h.timerCount(), 0)
})
