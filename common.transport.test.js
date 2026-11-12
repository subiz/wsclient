var test = require('node:test')
var assert = require('node:assert/strict')
var fs = require('node:fs')
var vm = require('node:vm')

function transport(globals) {
	var context = vm.createContext({module: {exports: {}}, ...globals})
	vm.runInContext(fs.readFileSync(require.resolve('./common.js'), 'utf8'), context)
	return context.module.exports.xhrsend
}

test('XHR transport abort suppresses all late completion callbacks', () => {
	var xhr
	class XHR {
		constructor() { xhr = this; this.aborts = 0 }
		open() {}
		send() {}
		abort() { this.aborts++; this.readyState = 4; this.status = 0; this.onreadystatechange(); this.onerror() }
	}
	var calls = []
	var send = transport({XMLHttpRequest: XHR})
	var handle = send('get', '/poll', undefined, (...args) => calls.push(args))
	handle.abort()
	xhr.readyState = 4
	xhr.status = 200
	xhr.responseText = 'late'
	xhr.onreadystatechange()
	assert.equal(xhr.aborts, 1)
	assert.equal(calls.length, 0)
})

test('XHR network completion invokes callback only once', () => {
	var xhr
	class XHR {
		constructor() { xhr = this }
		open() {}
		send() {}
	}
	var calls = 0
	transport({XMLHttpRequest: XHR})('get', '/poll', undefined, () => calls++)
	xhr.readyState = 4
	xhr.status = 0
	xhr.onreadystatechange()
	xhr.onerror()
	assert.equal(calls, 1)
})

test('fetch transport aborts its signal and suppresses a late body response', async () => {
	var signal, finishBody
	var send = transport({AbortController, fetch(url, options) {
		signal = options.signal
		return Promise.resolve({status: 200, text() { return new Promise((resolve) => { finishBody = resolve }) }})
	}})
	var calls = 0
	var handle = send('get', '/poll', undefined, () => calls++)
	await Promise.resolve()
	handle.abort()
	assert.equal(signal.aborted, true)
	finishBody('late')
	for (var i = 0; i < 10; i++) await Promise.resolve()
	assert.equal(calls, 0)
})

test('fetch transport reports network failure once', async () => {
	var send = transport({AbortController, fetch() { return Promise.reject(new Error('offline')) }})
	var codes = []
	send('get', '/poll', undefined, (body, code) => codes.push(code))
	for (var i = 0; i < 10; i++) await Promise.resolve()
	assert.deepEqual(codes, [-1])
})
