var flow = require('@subiz/flow')
var {xhrsend, parseJSON, Pubsub} = require('./common.js')

// Conn represents a realtime connection between an user and the realtime
// server (https://rt-0.subiz.com)
//
// You can subscribe for realtime events and it will sent you new events
// as fast as possible through onEvents callback.
//
// It will try it best to keep the communication with the realtime
// server. But if the user is offline for too long or the network can't
// keep up with incomming events (rarely happend with today internet speed).
// The connection will be killed. Dead.
//
// Once dead, onDead will be called. After that, the connection is
// useless, all resources will be released.
function Conn(apiUrl, credential, onDead, onEvents, callAPI, accid) {
	callAPI = callAPI || xhrsend // allow hook
	credential = credential || {}
	var lastToken = ''
	var lastAccessToken = ''
	if (!accid) accid = ''
	var is_dead = false // tell if the connection is dead
	var is_polling_stuck = false // tell if we've having trouble doing /poll
	var is_sub_stuck = true // tell if we've having trouble doing /subscribe

	// Server holds polls for at most 90s. Allow transport overhead, but recover
	// before a request can hang forever. Custom transports may return an abort handle.
	var POLL_TIMEOUT = 105000
	var timers = new Set()
	var requests = new Set()
	var subscriptions = new Set()
	function later(fn, delay) {
		var timer = setTimeout(function () {
			timers.delete(timer)
			if (!is_dead) fn()
		}, delay)
		timers.add(timer)
		return timer
	}
	function cancelTimer(timer) {
		clearTimeout(timer)
		timers.delete(timer)
	}
	function request(method, url, body, timeout, cb) {
		var settled = false
		var transport
		function abort() {
			try {
				if (typeof transport === 'function') transport()
				else if (transport && typeof transport.abort === 'function') transport.abort()
			} catch (err) { reportCallbackError(err) }
		}
		function cancel() {
			if (settled) return
			settled = true
			cancelTimer(timer)
			requests.delete(cancel)
			abort()
		}
		function complete(body, code) {
			if (settled || is_dead) return
			settled = true
			cancelTimer(timer)
			requests.delete(cancel)
			cb(body, code)
		}
		requests.add(cancel)
		var timer = later(function () {
			cancel()
			if (!is_dead) cb(undefined, -1)
		}, timeout)
		try { transport = callAPI(method, url, body, complete) }
		catch (err) { complete(undefined, -1) }
		// A synchronous custom transport can stop the connection before returning.
		if (is_dead) abort()
	}

	var MIN_POLL_INTERVAL = 250
	var polling_started = false
	function startPolling() {
		if (polling_started) return
		polling_started = true
		polling(0)
	}
	function polling(backoff) {
		if (is_dead) return
		var started = Date.now()
		request('get', apiUrl + 'poll?token=' + encodeURIComponent(lastToken) + '&v=5&account-id=' + encodeURIComponent(accid), undefined, POLL_TIMEOUT, function (body, code) {
			var wait = Math.max(0, MIN_POLL_INTERVAL - (Date.now() - started))
			if (retryable(code)) {
				is_polling_stuck = true
				return later(function () { polling(backoff + 1) }, Math.max(calcNextBackoff(backoff), wait))
			}
			if (code !== 200) {
				is_polling_stuck = true
				return kill('poll')
			}
			body = parseJSON(body) || {}
			if (!body.sequential_token) return kill('poll')
			is_polling_stuck = false
			if (body.host) apiUrl = absUrl(body.host)
			lastToken = body.sequential_token
			onEvents(body.events || [])
			if (!is_dead) later(function () { polling(0) }, wait)
		})
	}

	var subQueue = flow.batch(50, 100, function (topics) {
		if (is_dead) return Promise.resolve(repeat('dead', topics.length))
		if (!topics.length) return Promise.resolve([])
		return new Promise(function (resolve) {
			var done = false
			function finish(result) {
				if (done) return
				done = true
				cancelTimer(stuckTimer)
				cancelTimer(deadline)
				cancelTimer(retryTimer)
				subscriptions.delete(cancel)
				resolve(result)
			}
			function cancel() { finish(repeat('dead', topics.length)) }
			subscriptions.add(cancel)
			var stuckTimer = later(function () { is_sub_stuck = true }, 4000)
			var deadline = later(function () { is_sub_stuck = true; kill('subs') }, 60000)
			var retryTimer
			function retry() {
				if (done || is_dead) return
				is_sub_stuck = true
				retryTimer = later(attempt, 3000)
			}
			function attempt() {
				if (done || is_dead) return
				Promise.resolve().then(function () { return credential.getAccessToken() }).then(function (accessToken) {
					if (done || is_dead) return
					lastAccessToken = accessToken || ''
					var query = '?token=' + encodeURIComponent(lastToken)
					if (credential.user_ref) query += '&user_ref=' + encodeURIComponent(credential.user_ref)
					else if (credential.user_mask) query += '&user-mask=' + encodeURIComponent(credential.user_mask)
					else if (accessToken) query += '&access-token=' + encodeURIComponent(accessToken)
					var url = apiUrl + 'subs' + query + '&v=5&account-id=' + encodeURIComponent(accid || credential.account_id)
					request('post', url, JSON.stringify({events: topics}), 60000, function (body, code) {
						if (done || is_dead) return
						if (retryable(code)) return retry()
						if (code !== 200) return kill('subs')
						if (!lastToken) {
							body = parseJSON(body) || {}
							if (!body.initial_token) return kill('subs')
							if (body.host) apiUrl = absUrl(body.host)
							lastToken = body.initial_token
						}
						is_sub_stuck = false
						finish(topics)
						startPolling()
					})
				}).catch(retry)
			}
			attempt()
		})
	})

	// subscribe call /subs API to tell server that we are listening for those events
	// this function may start polling loop if it hasn't been started yet
	// its safe to call this function multiple times
	this.subscribe = subQueue.push.bind(subQueue)

	this.getStatus = function () {
		if (is_dead) return 'dead'
		if (is_sub_stuck || is_polling_stuck) return 'connecting'
		return 'active'
	}

	// Page exit cannot wait for credential refresh or a normal XHR response.
	this.cleanup = function (browserWindow) {
		if (is_dead || !lastToken) return
		var url = apiUrl + 'cleanup?token=' + encodeURIComponent(lastToken) + '&account-id=' + encodeURIComponent(accid)
		// Also support hosts where /rt goes through the standard API auth wrapper.
		if (credential.user_ref) url += '&user_ref=' + encodeURIComponent(credential.user_ref)
		else if (credential.user_mask) url += '&user-mask=' + encodeURIComponent(credential.user_mask)
		else if (lastAccessToken) url += '&access-token=' + encodeURIComponent(lastAccessToken)
		try {
			if (browserWindow.navigator && typeof browserWindow.navigator.sendBeacon === 'function') {
				if (browserWindow.navigator.sendBeacon(url)) return
			}
		} catch (e) {}
		try {
			if (typeof browserWindow.fetch === 'function') {
				Promise.resolve(browserWindow.fetch(url, {method: 'POST', keepalive: true, credentials: 'include'})).catch(function () {})
			}
		} catch (e) {}
	}

	// kill force the connection to dead state
	var kill = function (reason) {
		if (is_dead) return
		is_dead = true
		for (var timer of timers) clearTimeout(timer)
		timers.clear()
		for (var cancel of requests) cancel()
		for (var finish of subscriptions) finish()
		onDead(reason)
	}
	this.kill = kill
}

// Realtime helps you subscribe and listen realtime event from th
// realtime server
// Realtime is just a stronger Conn.
function Realtime(apiUrls, credential, callAPI, accid, skipautoreconnect) {
	if (typeof apiUrls === 'string' || apiUrls instanceof String) apiUrls = [apiUrls]
	credential = credential || {}
	if (!credential.getAccessToken) {
		credential.getAccessToken = function () {
			return Promise.resolve('')
		}
	}
	if (!accid) accid = credential.account_id || ''
	var pubsub = new Pubsub(reportCallbackError)
	var reconnectTimer
	var stopped = false
	var leavingPage = false
	var browserWindow =
		typeof window !== 'undefined' &&
		window.document &&
		typeof window.addEventListener === 'function' &&
		typeof window.removeEventListener === 'function'
			? window
			: undefined

	var onPageHide = function (event) {
		// A page saved in the back/forward cache may resume this connection.
		if (event.persisted || leavingPage) return
		leavingPage = true
		clearTimeout(reconnectTimer)
		reconnectTimer = undefined
		browserWindow.removeEventListener('pagehide', onPageHide)
		if (!conn) return
		var oldconn = conn
		conn = undefined
		oldconn.cleanup(browserWindow)
		oldconn.kill('pagehide')
	}

	// holds all topics that realtime must subscribed
	var topics = {}

	// stop the connection
	this.stop = function () {
		stopped = true
		clearTimeout(reconnectTimer)
		reconnectTimer = undefined
		if (browserWindow) browserWindow.removeEventListener('pagehide', onPageHide)
		if (!conn) return
		// detach before killing so onDead knows this is intentional and
		// doesn't schedule a reconnect
		var oldconn = conn
		conn = undefined
		oldconn.kill()
		pubsub.emit('interrupted')
	}

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.onInterrupted = function (cb) {
		return pubsub.on('interrupted', cb)
	}

	this.getStatus = function () {
		if (!conn) return 'dead'
		return conn.getStatus()
	}

	var subscribe = function (events) {
		if (!conn) return Promise.resolve({error: 'dead'})
		if (typeof events === 'string') events = [events]
		if (!Array.isArray(events)) return Promise.resolve({error: 'param should be an array or string'})

		// ignore already subscribed events
		var all = []
		for (var i = 0; i < events.length; i++) {
			var topic = events[i]
			if (!topic) continue
			if (topics[topic]) continue
			topics[topic] = true // mark so next time we wont subscribe this event (topic) again
			all.push(conn.subscribe(topic))
		}
		if (all.length === 0) return Promise.resolve({})
		return Promise.all(all).then(function () {
			if (!conn || conn.getStatus() == 'dead') return {error: 'dead'}
			return {}
		})
	}
	this.subscribe = subscribe

	// reconnect make sure there is alway a Conn running in the background
	// if the Conn is dead, it recreate a new one
	var conn
	var reconnect = function () {
		if (leavingPage) return Promise.resolve({error: 'dead'})
		stopped = false
		clearTimeout(reconnectTimer)
		reconnectTimer = undefined
		if (browserWindow) browserWindow.addEventListener('pagehide', onPageHide)
		var randomUrl = apiUrls[Math.floor(Math.random() * apiUrls.length)]
		if (conn) {
			// detach before killing so the old conn's onDead doesn't
			// schedule another reconnect (which would kill this new conn,
			// schedule another one, and churn forever)
			var oldconn = conn
			conn = undefined
			oldconn.kill()
		}
		var myconn = new Conn(
			randomUrl,
			credential,
			function (code, body, status) {
				if (conn === undefined || myconn != conn) return // outdated
				conn = undefined // prevent dupplicate dead fire
				pubsub.emit('interrupted', code, body, status)
				if (!skipautoreconnect && !stopped && !leavingPage) reconnectTimer = setTimeout(reconnect, 2000)
			},
			function (events) {
				if (myconn != conn) return
				for (var i = 0; i < events.length; i++) pubsub.emit('event', events[i])
			},
			callAPI,
			accid,
		)
		conn = myconn
		var copyTopics = Object.keys(topics)
		topics = {}
		// resubscribe all subscribed events
		return subscribe(copyTopics)
	}
	this.reconnect = reconnect
	reconnect()
}

// calcNextBackoff returns number of seconds we must wait
// before sending a next request
// the results is determind based on exponential backoff algorithm
// see https://en.wikipedia.org/wiki/Exponential_backoff
function calcNextBackoff(attempts) {
	var RECONNECT_INTERVAL = 1000
	var MAX_RECONNECT_INTERVAL = 10000
	var RECONNECT_DECAY = 1.5

	if (!attempts || attempts === -1) return 0 // first time connect
	var delaytime = RECONNECT_INTERVAL * Math.pow(RECONNECT_DECAY, attempts)
	return Math.min(MAX_RECONNECT_INTERVAL, delaytime)
}

// retryable decides whether we should resent the HTTP request
// based on last response or network state
function retryable(code) {
	// code = 0 means server return response without CORS header, so we are unable to read it
	// code = -1 means the network connection is dead
	return (code >= 500 && code < 600) || code === 0 || code === -1 || code === 429
}

function repeat(ele, n) {
	var arr = []
	for (var i = 0; i < n; i++) arr.push(ele)
	return arr
}

function absUrl(url) {
	url = url || ''
	if (url.startsWith('//')) return 'https:' + url
	return url
}

function reportCallbackError(err) {
	try {
		if (typeof console !== 'undefined' && console.error) console.error('Realtime callback failed:', err)
	} catch (ignored) {}
}

module.exports = Realtime
