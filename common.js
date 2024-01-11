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

module.exports = {xhrsend, parseJSON, Pubsub, randomString, logError}
