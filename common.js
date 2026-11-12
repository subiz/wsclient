function logError(accid, userid, message, line) {
	// 24-01-11 04:07:05 app ERROR api-8948967b6-qtpfx subiz /app/vendor/github.com/subiz/log/error.go:271 {"id":141534190473829746,"class":500,"code":"locked_account,internal","number":"8f2b97e9","fields":{"ip":"\"171.224.84.93\"","no_report":"true","user_agent":"\"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36\""}}
	let ts = displayUTCLogTime(new Date())
	let msg = JSON.stringify({
		id: Date.now(),
		class: 400,
		code: 'frontend_error',
		number: line
			.split('')
			.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
			.join(''),
		fields: {
			message: JSON.stringify(message),
			user_id: userid,
			url: JSON.stringify(location.href),
		},
	})

	xhrsend('POST', 'https://track.subiz.net/collect', `${ts} app ERROR dashboard ${accid} ${line} ${msg}`)
}

function displayUTCLogTime(date) {
	let yyyy = date.getUTCFullYear().toString()
	let yy = yyyy.substr(2, 2)
	let mm = date.getUTCMonth() + 1
	let dd = date.getUTCDate()
	let hh = date.getUTCHours()
	let MM = date.getUTCMinutes()
	let ss = date.getUTCSeconds()

	return `${yy}-${pad(mm)}-${pad(dd)} ${pad(hh)}:${pad(MM)}:${pad(ss)}`
}

function pad(v) {
	if (v < 10) return `0${v}`
	return `${v}`
}

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

module.exports = {reportCallbackError, xhrsend, parseJSON, Pubsub, randomString, logError}
