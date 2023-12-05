function dofetch(method, url, body, cb) {
	let headers = {}
	if (body) headers['content-type'] = 'text/plain'
	fetch(url, {method: method, headers: headers, body: body})
		.then((res) => res.text().then((text) => cb && cb(text, res.status)))
		.catch((err) => cb && cb(err, -1))
}

// xhrsend sends an HTTP request
var xhrsend = function (method, url, body, cb) {
	if (typeof XMLHttpRequest === 'undefined') return dofetch(method, url, body, cb)
	var request = new XMLHttpRequest()
	request.onreadystatechange = function (e) {
		if (request.readyState !== 4) return
		cb && cb(request.responseText, request.status)
		cb = undefined // dont call cb anymore
	}

	request.onerror = function () {
		cb && cb(request.responseText, -1) // network error
		cb = undefined // dont call cb anymore
	}

	request.open(method, url)
	if (body) request.setRequestHeader('content-type', 'text/plain')
	request.send(body)
}

// JSON.parse without exeption
// return undefined when parsing invalid JSON string
function parseJSON(str) {
	try {
		return JSON.parse(str)
	} catch (e) {}
}

function Pubsub() {
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
		for (var i = 0; i < cbs.length; i++) cbs[i].apply(undefined, args)
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

module.exports = {xhrsend, parseJSON, Pubsub, randomString}
