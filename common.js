function dofetch(method, url, body, cb) {
	let headers = {}
	let controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
	if (body) headers['content-type'] = 'text/plain'
	function complete(body, code) {
		let callback = cb
		cb = undefined
		if (callback) callback(body, code)
	}
	fetch(url, {method: method, headers: headers, body: body, signal: controller && controller.signal})
		.then((res) => res.text().then((text) => ({text, status: res.status})))
		.then(
			(res) => complete(res.text, res.status),
			(err) => complete(err, -1),
		)
	return {
		abort() {
			cb = undefined
			if (controller) controller.abort()
		},
	}
}

// xhrsend returns an abort handle. The owner controls the request deadline.
var xhrsend = function (method, url, body, cb) {
	if (typeof XMLHttpRequest === 'undefined') return dofetch(method, url, body, cb)
	var request = new XMLHttpRequest()
	function complete(body, code) {
		var callback = cb
		cb = undefined
		if (callback) callback(body, code)
	}
	request.onreadystatechange = function () {
		if (request.readyState === 4) complete(request.responseText, request.status)
	}
	request.onerror = function () {
		complete(request.responseText, -1)
	}
	request.open(method, url)
	if (body) request.setRequestHeader('content-type', 'text/plain')
	request.send(body)
	return {
		abort() {
			cb = undefined
			request.abort()
		},
	}
}

// JSON.parse without exception
// return undefined when input is an invalid JSON
function parseJSON(str) {
	try {
		return JSON.parse(str)
	} catch (e) {}
}

function Pubsub(onError) {
	// holds all subscriptions for all topics
	// example {
	//   topic1: [cb1, cb2],
	//   topic2: [cb3, cb4],
	// }
	var listeners = {}

	// emit notifies any callback functions that previously
	// subscribed to the topic (by the on function)
	this.emit = function (topic) {
		// skip the first item in arguments, which is the topic
		var args = []
		for (var i = 1; i < arguments.length; i++) args.push(arguments[i])

		var cbs = listeners[topic]
		if (!cbs) return
		for (var i = 0; i < cbs.length; i++) {
			if (!onError) {
				cbs[i].apply(undefined, args)
				continue
			}
			try {
				var result = cbs[i].apply(undefined, args)
				if (result && typeof result.then === 'function') Promise.resolve(result).catch(onError)
			} catch (err) {
				onError(err)
			}
		}
	}

	// register a callback function for a topic
	// when something is sent to the topic (by the emit function),
	// the callback function will be called
	this.on = function (topic, cb) {
		if (!listeners[topic]) listeners[topic] = []
		listeners[topic].push(cb)
	}
}

function randomString(len, base) {
	var str = ''
	if (!len || len < 1) len = 10
	var asciiKey
	for (var i = 0; i < len; i++) {
		if (base) {
			str += base[Math.floor(Math.random() * base.length)]
		} else {
			asciiKey = Math.floor(Math.random() * 25 + 97)
			str += String.fromCharCode(asciiKey)
		}
	}
	return str
}

// Reporting consumer failures must itself be safe in browser and native hosts.
function reportCallbackError(err) {
	try {
		if (typeof console !== 'undefined' && console.error) console.error('Callback failed:', err)
	} catch (ignored) {}
}

module.exports = {reportCallbackError, xhrsend, parseJSON, Pubsub, randomString}
