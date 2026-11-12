var test = require('node:test')
var assert = require('node:assert/strict')
var fs = require('node:fs')
var path = require('node:path')
var vm = require('node:vm')
var {createRequire} = require('node:module')

// Run the real client with isolated browser globals
// and a clock we can advance without waiting for reconnect/subscription timers.
function environment(options = {}) {
	var now = 100000
	var nextTimer = 0
	var timers = new Map()
	var listeners = new Map()
	var calls = []
	var beacons = []
	var fetches = []
	var errors = []
	var browser = {
		document: {},
		navigator: {},
		addEventListener(type, cb) {
			if (!listeners.has(type)) listeners.set(type, new Set())
			listeners.get(type).add(cb)
		},
		removeEventListener(type, cb) {
			if (listeners.has(type)) listeners.get(type).delete(cb)
		},
		fetch(url, init) {
			fetches.push({url, init})
			if (options.fetch === 'throw') throw new Error('fetch unavailable')
			if (options.fetch === 'reject') return Promise.reject(new Error('offline'))
			return Promise.resolve({status: 204})
		},
	}
	if (options.beacon !== 'missing') {
		browser.navigator.sendBeacon = function (url) {
			beacons.push(url)
			if (options.beacon === 'throw') throw new Error('beacon unavailable')
			return options.beacon !== 'false'
		}
	}
	if (options.fetch === 'missing') delete browser.fetch
	if (options.browser === 'native') delete browser.document
	var globals = {
		console: {error(...args) { errors.push(args) }},
		URL,
		Date: class extends Date {
			static now() { return now }
		},
		setTimeout(fn, delay, ...args) {
			var id = ++nextTimer
			timers.set(id, {at: now + Math.max(Number(delay) || 0, 0), fn, args})
			return id
		},
		clearTimeout(id) { timers.delete(id) },
	}
	if (options.browser !== false) globals.window = browser
	var context = vm.createContext(globals)
	var modules = new Map()
	function load(filename) {
		if (modules.has(filename)) return modules.get(filename).exports
		var mod = {exports: {}}
		modules.set(filename, mod)
		var resolve = createRequire(filename).resolve
		var wrapper = vm.runInContext('(function(require, module, exports) {\n' + fs.readFileSync(filename, 'utf8') + '\n})', context, {filename})
		wrapper((name) => load(resolve(name)), mod, mod.exports)
		return mod.exports
	}
	var Realtime = load(path.join(__dirname, 'realtime.js'))
	async function flush() {
		for (var i = 0; i < 30; i++) await Promise.resolve()
	}
	async function tick(ms) {
		await flush()
		var end = now + ms
		for (var i = 0; i < 1000; i++) {
			var due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
			if (!due) {
				now = end
				await flush()
				return
			}
			timers.delete(due[0])
			now = due[1].at
			due[1].fn(...due[1].args)
			await flush()
		}
		throw new Error('timer loop did not settle')
	}
	function take(endpoint) {
		var call = calls.find((call) => !call.taken && new URL(call.url).pathname.endsWith('/' + endpoint))
		assert.ok(call, 'expected ' + endpoint + ' request')
		call.taken = true
		return call
	}
	function create(credential = {account_id: 'ac-test'}, skipautoreconnect) {
		return new Realtime('https://api.example.com/rts/0/', credential, (method, url, body, cb) => {
			var call = {method, url, body, cb, aborts: 0}
			calls.push(call)
			return {abort() { call.aborts++; cb('aborted', -1) }}
		}, undefined, skipautoreconnect)
	}
	async function connect(credential, token = 'initial-token') {
		var realtime = create(credential)
		var ready = realtime.subscribe('message_sent')
		await tick(100)
		take('subs').cb(JSON.stringify({initial_token: token, host: '//api.example.com/rt/2/'}), 200)
		await ready
		return realtime
	}
	return {
		calls, beacons, fetches, errors, tick, flush, take, create, connect,
		timerCount() { return timers.size },
		emit(type, event = {}) { for (var cb of [...(listeners.get(type) || [])]) cb(event) },
		listenerCount() { return (listeners.get('pagehide') || new Set()).size },
	}
}

test('subscriptions share a 100ms batching window without duplicate topics', async () => {
	var h = environment()
	var rt = h.create()
	var first = rt.subscribe(['first', 'shared'])
	await h.tick(60)
	var second = rt.subscribe(['shared', 'second'])
	await h.tick(39)
	assert.equal(h.calls.length, 0)
	await h.tick(1)
	var sub = h.take('subs')
	assert.deepEqual(JSON.parse(sub.body).events, ['first', 'shared', 'second'])
	sub.cb(JSON.stringify({initial_token: 'initial'}), 200)
	for (var result of await Promise.all([first, second])) assert.equal(result.error, undefined)
	rt.stop()
	assert.equal(h.timerCount(), 0)
})

test('large subscription queues send at most 50 topics serially using the latest token and host', async () => {
	var h = environment()
	var rt = h.create()
	var topics = Array.from({length: 121}, (_, i) => 'topic-' + i)
	var ready = rt.subscribe(topics)
	await h.tick(0)
	var first = h.take('subs')
	assert.deepEqual(JSON.parse(first.body).events, topics.slice(0, 50))
	var extra = rt.subscribe(['topic-0', 'extra'])
	await h.tick(200)
	assert.equal(h.calls.length, 1, 'wait for the active subscription before sending more')
	first.cb(JSON.stringify({initial_token: 'initial', host: '//api.example.com/rt/2/'}), 200)
	await h.tick(0)
	var second = h.take('subs')
	assert.deepEqual(JSON.parse(second.body).events, topics.slice(50, 100))
	assert.equal(new URL(second.url).pathname, '/rt/2/subs')
	assert.equal(new URL(second.url).searchParams.get('token'), 'initial')
	h.take('poll').cb(JSON.stringify({sequential_token: 'latest', events: []}), 200)
	second.cb('{}', 200)
	await h.tick(0)
	var third = h.take('subs')
	assert.deepEqual(JSON.parse(third.body).events, topics.slice(100).concat('extra'))
	assert.equal(new URL(third.url).searchParams.get('token'), 'latest')
	third.cb('{}', 200)
	for (var result of await Promise.all([ready, extra])) assert.equal(result.error, undefined)
	assert.equal(h.calls.filter((call) => new URL(call.url).pathname.endsWith('/subs')).length, 3)
	rt.stop()
	assert.equal(h.timerCount(), 0)
})

test('stop settles topics still waiting for their batching window', async () => {
	var h = environment()
	var rt = h.create()
	var pending = rt.subscribe(['first', 'second'])
	rt.stop()
	assert.equal((await pending).error, 'dead')
	assert.equal(h.timerCount(), 0)
	await h.tick(1000)
	assert.equal(h.calls.length, 0)
})

for (const failure of ['stop', 'http', 'timeout']) {
	test('active and queued subscription batches settle on ' + failure, async () => {
		var h = environment()
		var rt = h.create(undefined, true)
		var pending = rt.subscribe(Array.from({length: 125}, (_, i) => 'topic-' + i))
		await h.tick(0)
		var active = h.take('subs')
		if (failure === 'stop') rt.stop()
		else if (failure === 'http') active.cb('forbidden', 403)
		else await h.tick(60000)
		assert.equal((await pending).error, 'dead')
		assert.equal(h.timerCount(), 0)
		active.cb(JSON.stringify({initial_token: 'late'}), 200)
		await h.tick(120000)
		assert.equal(h.calls.length, 1)
	})
}

test('reconnect cancels the old queue and resubscribes every remembered topic', async () => {
	var h = environment()
	var rt = h.create()
	var topics = Array.from({length: 60}, (_, i) => 'topic-' + i)
	var pending = rt.subscribe(topics)
	await h.tick(0)
	var old = h.take('subs')
	var ready = rt.reconnect()
	assert.equal(old.aborts, 1)
	await pending
	await h.tick(0)
	var first = h.take('subs')
	assert.deepEqual(JSON.parse(first.body).events, topics.slice(0, 50))
	assert.equal(new URL(first.url).searchParams.get('token'), '')
	first.cb(JSON.stringify({initial_token: 'new'}), 200)
	old.cb(JSON.stringify({initial_token: 'old'}), 200)
	await h.tick(100)
	var second = h.take('subs')
	assert.deepEqual(JSON.parse(second.body).events, topics.slice(50))
	assert.equal(new URL(second.url).searchParams.get('token'), 'new')
	second.cb('{}', 200)
	assert.equal((await ready).error, undefined)
	rt.stop()
	assert.equal(h.timerCount(), 0)
})

test('page exit cleans the latest token and host once, then stops all activity', async () => {
	var h = environment()
	var authCalls = 0
	var rt = await h.connect({account_id: 'ac&test', getAccessToken() { authCalls++; return Promise.resolve('access&token') }})
	h.take('poll').cb(JSON.stringify({sequential_token: 'latest+token/=', host: '//api.example.com/rt/1/', events: []}), 200)
	await h.tick(250)
	var pendingPoll = h.take('poll')
	h.emit('pagehide', {persisted: false})
	h.emit('pagehide', {persisted: false})
	assert.equal(h.beacons.length, 1)
	var url = new URL(h.beacons[0])
	assert.equal(url.origin + url.pathname, 'https://api.example.com/rt/1/cleanup')
	assert.equal(url.searchParams.get('token'), 'latest+token/=')
	assert.equal(url.searchParams.get('account-id'), 'ac&test')
	assert.equal(url.searchParams.get('access-token'), 'access&token')
	assert.equal(authCalls, 1, 'exit does not wait for another credential refresh')
	assert.equal(h.fetches.length, 0)
	assert.equal(h.listenerCount(), 0)
	assert.equal(rt.getStatus(), 'dead')
	var count = h.calls.length
	pendingPoll.cb(JSON.stringify({sequential_token: 'too-late'}), 200)
	assert.equal((await rt.reconnect()).error, 'dead')
	await h.tick(120000)
	assert.equal(h.calls.length, count, 'late callbacks/timers must not revive a cleaned connection')
})

test('hidden tabs, offline retries and back/forward caching preserve the connection', async () => {
	var h = environment()
	var rt = await h.connect()
	h.emit('visibilitychange')
	h.emit('offline')
	h.emit('pagehide', {persisted: true})
	assert.equal(h.beacons.length, 0)
	assert.equal(rt.getStatus(), 'active')
	assert.equal(h.listenerCount(), 1)
	h.take('poll').cb('offline', 0)
	await h.tick(250)
	assert.equal(new URL(h.take('poll').url).searchParams.get('token'), 'initial-token')
	assert.equal(h.beacons.length, 0)
	h.emit('pageshow', {persisted: true})
	h.emit('pagehide', {persisted: false})
	assert.equal(h.beacons.length, 1)
})

for (const beacon of ['missing', 'false', 'throw']) {
	test('keepalive POST fallback when beacon is ' + beacon, async () => {
		var h = environment({beacon})
		var rt = await h.connect()
		h.emit('pagehide')
		assert.equal(h.fetches.length, 1)
		assert.equal(h.fetches[0].init.method, 'POST')
		assert.equal(h.fetches[0].init.keepalive, true)
		assert.equal(h.fetches[0].init.credentials, 'include')
		assert.equal(new URL(h.fetches[0].url).searchParams.get('token'), 'initial-token')
		assert.equal(rt.getStatus(), 'dead')
	})
}

for (const fetchMode of ['missing', 'reject', 'throw']) {
	test('failed cleanup delivery still stops the exiting page: ' + fetchMode, async () => {
		var h = environment({beacon: 'false', fetch: fetchMode})
		var rt = await h.connect()
		assert.doesNotThrow(() => h.emit('pagehide'))
		await h.flush()
		assert.equal(rt.getStatus(), 'dead')
		assert.equal(h.listenerCount(), 0)
	})
}

test('page exit before subscribing has no token to clean and ignores late subscriptions', async () => {
	var h = environment()
	var rt = h.create()
	rt.subscribe('message_sent')
	await h.tick(100)
	var pending = h.take('subs')
	h.emit('pagehide')
	pending.cb(JSON.stringify({initial_token: 'too-late'}), 200)
	await h.tick(120000)
	assert.equal(h.beacons.length, 0)
	assert.equal(h.fetches.length, 0)
	assert.equal(rt.getStatus(), 'dead')
	assert.equal(h.calls.length, 1)
})

test('page exit cancels an already scheduled automatic reconnect', async () => {
	var h = environment()
	var rt = await h.connect()
	h.take('poll').cb('invalid connection', 400)
	h.emit('pagehide')
	var count = h.calls.length
	await h.tick(120000)
	assert.equal(h.calls.length, count)
	assert.equal(rt.getStatus(), 'dead')
	assert.equal(h.beacons.length, 0, 'already dead connection needs no beacon')
})

test('stop removes the listener and cancels retries; reconnect registers just one listener', async () => {
	var h = environment()
	var rt = await h.connect()
	h.take('poll').cb('invalid connection', 400)
	rt.stop()
	assert.equal(h.listenerCount(), 0)
	var count = h.calls.length
	await h.tick(2000)
	assert.equal(h.calls.length, count)
	var ready = rt.reconnect()
	await h.tick(100)
	h.take('subs').cb(JSON.stringify({initial_token: 'new-connection'}), 200)
	await ready
	assert.equal(h.listenerCount(), 1)
	h.emit('pagehide')
	assert.equal(h.beacons.length, 1)
	assert.equal(new URL(h.beacons[0]).searchParams.get('token'), 'new-connection')
})

for (const browser of [false, 'native']) {
	test('non-web runtime has no exit listener: ' + browser, async () => {
		var h = environment({browser})
		var rt = await h.connect()
		h.emit('pagehide')
		assert.equal(h.listenerCount(), 0)
		assert.equal(h.beacons.length, 0)
		assert.equal(rt.getStatus(), 'active')
		rt.stop()
	})
}

test('visitor credentials preserve subscription precedence in cleanup', async () => {
	for (var credential of [
		{account_id: 'ac-test', user_ref: 'ref&123', user_mask: 'ignored'},
		{account_id: 'ac-test', user_mask: 'mask+123'},
	]) {
		var h = environment()
		await h.connect(credential)
		h.emit('pagehide')
		var url = new URL(h.beacons[0])
		assert.equal(url.searchParams.get('user_ref'), credential.user_ref || null)
		assert.equal(url.searchParams.get('user-mask'), credential.user_ref ? null : credential.user_mask)
	}
})

test('throwing and rejecting listeners do not lose other events or stop polling', async () => {
	var h = environment()
	var rt = await h.connect()
	var received = []
	rt.onEvent(() => { throw new Error('broken listener') })
	rt.onEvent(async () => { throw new Error('broken async listener') })
	rt.onEvent((event) => received.push(event.id))
	h.take('poll').cb(JSON.stringify({sequential_token: 'next', events: [{id: 1}, {id: 2}]}), 200)
	await h.tick(250)
	assert.deepEqual(received, [1, 2])
	assert.equal(h.errors.length, 4)
	assert.equal(new URL(h.take('poll').url).searchParams.get('token'), 'next')
	assert.equal(rt.getStatus(), 'active')
	rt.stop()
})

test('throwing interrupted listeners cannot prevent automatic reconnect', async () => {
	var h = environment()
	var rt = await h.connect()
	var interruptions = 0
	rt.onInterrupted(() => { throw new Error('broken listener') })
	rt.onInterrupted(() => interruptions++)
	h.take('poll').cb('dead', 400)
	await h.tick(2100)
	h.take('subs').cb(JSON.stringify({initial_token: 'reconnected'}), 200)
	assert.equal(interruptions, 1)
	assert.equal(h.errors.length, 1)
	assert.equal(rt.getStatus(), 'active')
	rt.stop()
})

test('poll deadline aborts once, retries the same token and ignores late responses', async () => {
	var h = environment()
	var rt = await h.connect()
	var received = []
	rt.onEvent((event) => received.push(event))
	var hung = h.take('poll')
	await h.tick(90000)
	assert.equal(hung.aborts, 0, 'normal server hold is allowed')
	await h.tick(15000)
	assert.equal(hung.aborts, 1)
	assert.equal(rt.getStatus(), 'connecting')
	var retry = h.take('poll')
	assert.equal(new URL(retry.url).searchParams.get('token'), 'initial-token')
	hung.cb(JSON.stringify({sequential_token: 'stale', events: [{id: 'stale'}]}), 200)
	assert.equal(received.length, 0)
	retry.cb(JSON.stringify({sequential_token: 'recovered', events: [{id: 'ok'}]}), 200)
	await h.tick(250)
	assert.equal(received.length, 1)
	assert.equal(rt.getStatus(), 'active')
	assert.equal(new URL(h.take('poll').url).searchParams.get('token'), 'recovered')
	rt.stop()
	assert.equal(h.timerCount(), 0)
})

test('stop aborts in-flight requests and settles subscription promises immediately', async () => {
	var h = environment()
	var rt = await h.connect()
	var poll = h.take('poll')
	var pending = rt.subscribe('extra')
	await h.tick(100)
	var sub = h.take('subs')
	rt.stop()
	assert.equal((await pending).error, 'dead')
	assert.equal(poll.aborts, 1)
	assert.equal(sub.aborts, 1)
	await h.flush()
	assert.equal(h.timerCount(), 0)
	var count = h.calls.length
	await h.tick(300000)
	assert.equal(h.calls.length, count)
})

test('reconnect aborts the old poll and rejects its late callback', async () => {
	var h = environment()
	var rt = await h.connect()
	var oldPoll = h.take('poll')
	var ready = rt.reconnect()
	assert.equal(oldPoll.aborts, 1)
	await h.tick(100)
	h.take('subs').cb(JSON.stringify({initial_token: 'new'}), 200)
	await ready
	oldPoll.cb('late failure', 400)
	assert.equal(new URL(h.take('poll').url).searchParams.get('token'), 'new')
	assert.equal(rt.getStatus(), 'active')
	rt.stop()
})

test('stop during credential refresh settles the subscription without sending later', async () => {
	var h = environment()
	var resolveCredential
	var rt = h.create({getAccessToken() { return new Promise((resolve) => { resolveCredential = resolve }) }})
	var pending = rt.subscribe('message_sent')
	await h.tick(100)
	rt.stop()
	assert.equal((await pending).error, 'dead')
	resolveCredential('late')
	await h.tick(300000)
	assert.equal(h.calls.length, 0)
	assert.equal(h.timerCount(), 0)
})
