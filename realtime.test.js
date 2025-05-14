var test = require('tape')
var Realtime = require('./realtime.js')

async function testScript(t, script) {
	let events = []
	let calls = []
	var realtime = new Realtime(
		'https://api5.subiz.com.vn/',
		{user_mask: 'mask123'},
		(method, url, body, cb) => {
			calls.push({method, url, body, cb})
		},
		'acctest',
		!script.auto_reconnect,
	)
	realtime.onEvent((ev) => events.push(ev))

	for (let stepi in script.steps) {
		let step = script.steps[stepi]
		if (step.type == 'status') {
			t.equal(realtime.getStatus(), step.status, script.name + '[' + stepi + ']')
			continue
		}

		if (step.type == 'subscribe') {
			realtime.subscribe(step.topics)
			continue
		}

		if (step.type == 'reconnect') {
			realtime.reconnect()
			continue
		}

		if (step.type == 'wait') {
			await sleep(step.timeout)
			continue
		}

		if (step.type == 'call') {
			t.true(step.call_id != undefined) // must define call id in the script
			let start = Date.now()
			let timeout = step.timeout || 10_000
			let istimeout
			for (;;) {
				if (Date.now() - start > timeout) {
					istimeout = true
					break
				}
				// wait util api is called
				await sleep(100)
				let call
				for (let c = 0; c < calls.length; c++) {
					if (!calls[c].call_id) {
						call = calls[c]
						break
					}
				}
				if (!call) continue
				call.call_id = step.call_id
				const myUrl = new URL(call.url)

				if (step.path) t.equal(myUrl.pathname, step.path)

				if (step.method) t.equal(step.method, call.method)

				if (step.query) {
					for (var key of Object.keys(step.query)) {
						t.equal(step.query[key], myUrl.searchParams.get(key), script.name)
					}
				}

				if (step.body) {
					let keys = Object.keys(step.body)
					let callbody
					if (call.body) callbody = JSON.parse(call.body)
					for (var key of keys) {
						t.equal(JSON.stringify(step.body[key]), JSON.stringify(callbody[key]))
					}
				}
				break
			}

			t.true(!istimeout, script.name + ' ' + stepi + ' ' + JSON.stringify(step))
			continue
		}

		if (step.type == 'response') {
			let call
			for (var c = 0; c < calls.length; c++) {
				if (calls[c].call_id == step.call_id) {
					call = calls[c]
					break
				}
			}

			t.true(call != undefined)
			call.cb(JSON.stringify(step.body), step.code)
			continue
		}
		t.true(false, script.name + '[' + stepi + ']=' + step.type)
	}
	// check events
	let scriptevents = script.events || []
	t.equal(events.length, scriptevents.length)
	for (let i in events) {
		t.equal(JSON.stringify(events[i]), JSON.stringify(scriptevents[i]))
	}
	realtime.stop()
}

test.only('realtime', async (t) => {
	let scripts = [
		{
			name: 'starting status',
			steps: [
				{type: 'status', status: 'active'},
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '1', path: '/subs', method: 'post', body: {events: ['message_sent']}},
				{type: 'wait', timeout: 5000},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 60000},
				{type: 'status', status: 'dead'},
				{type: 'response', call_id: '1', body: {initial_token: 'aaaaaa'}, code: 200},
				{type: 'status', status: 'dead'}, // dead must be dead
			],
		},
		{
			name: 'long subscribe',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '1', path: '/subs', method: 'post', body: {events: ['message_sent']}},
				{type: 'wait', timeout: 5000},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 3000},
				{type: 'status', status: 'connecting'},
				{type: 'response', call_id: '1', body: {initial_token: 'aaaaaa'}, code: 200},
				{type: 'status', status: 'active'},
			],
			events: [],
		},
		{
			name: 'double subscribe -> do nothing',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '1', path: '/subs', method: 'post', body: {events: ['message_sent']}},
				{type: 'response', call_id: '1', body: {initial_token: 'token1'}, code: 200},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'subscribe', topics: ['message_sent', 'message_pong']},
				{type: 'call', call_id: '3', path: '/subs', method: 'post', body: {events: ['message_pong']}},
			],
		},
		{
			name: 'polling unstable',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '1', path: '/subs', method: 'post', body: {events: ['message_sent']}},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '1', body: {initial_token: 'token1'}, code: 200},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'wait', timeout: 30000},
				{type: 'response', call_id: '2', body: 'network disconnected', code: 0},
				{type: 'status', status: 'connecting'},
				{type: 'call', call_id: '3', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'wait', timeout: 30000},
				{type: 'response', call_id: '3', body: '500 keep internal', code: 500},
				// more than 60 sec without any data => dead
				{type: 'status', status: 'connecting'},
			],
		},
		{
			name: 'polling dead',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '1', path: '/subs', method: 'post', body: {events: ['message_sent']}},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '1', body: {initial_token: 'token1'}, code: 200},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'response', call_id: '2', body: '400 dead', code: 400},
				{type: 'status', status: 'dead'},
			],
		},
		{
			name: 'basic',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{
					type: 'call',
					call_id: '1',
					path: '/subs',
					query: {'user-mask': 'mask123'},
					method: 'post',
					body: {events: ['message_sent']},
				},
				{type: 'response', call_id: '1', body: {initial_token: 'token1'}, code: 200},
				{type: 'wait', timeout: 1000},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'status', status: 'active'},
				{type: 'wait', timeout: 3000},
				{type: 'response', call_id: '2', body: {events: [{text: 'xin chao'}], sequential_token: 'token2'}, code: 200},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '3', path: '/poll', query: {token: 'token2'}, method: 'get'},
			],
			events: [{text: 'xin chao'}],
		},
		{
			name: 'realtime subs when server down and then backup',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{
					type: 'call',
					call_id: '1',
					path: '/subs',
					method: 'post',
					body: {events: ['message_sent']},
				},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '1', body: '502 too busy', code: 502},
				{
					type: 'call',
					call_id: '1.1',
					path: '/subs',
					method: 'post',
					body: {events: ['message_sent']},
				},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '1.1', body: '502 still busy', code: 502},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 1000},
				{
					type: 'call',
					call_id: '1.2',
					path: '/subs',
					method: 'post',
					body: {events: ['message_sent']},
				},
				{type: 'status', status: 'connecting'},
				{type: 'response', call_id: '1.2', body: {initial_token: 'token1'}, code: 200},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'status', status: 'active'},
				{type: 'wait', timeout: 3000},
				{type: 'response', call_id: '2', body: {events: [{text: 'xin chao'}], sequential_token: 'token2'}, code: 200},
				{type: 'status', status: 'active'},
				{type: 'call', call_id: '3', path: '/poll', query: {token: 'token2'}, method: 'get'},
			],
			events: [{text: 'xin chao'}],
		},
		{
			name: 'realtime must stop if there is something wrong with our credential or our code',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'call', call_id: 1, path: '/subs'},
				{type: 'response', call_id: 1, body: '400 invalid mask', code: 400},
				{type: 'status', status: 'dead'},
			],
		},
		{
			name: 'reconect',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'call', call_id: 1, path: '/subs'},
				{type: 'response', call_id: 1, body: '400 invalid mask', code: 400},
				{type: 'status', status: 'dead'},
				{type: 'reconnect'},
				{type: 'wait', timeout: 1000},
				{type: 'call', call_id: 2, path: '/subs'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: 2, body: {initial_token: 'token1'}, code: 200},
				{type: 'status', status: 'active'},
			],
		},
		{
			name: 'reconect while poll',
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'call', call_id: 1, path: '/subs'},
				{type: 'response', call_id: '1', body: {initial_token: 'token1'}, code: 200},
				{type: 'call', call_id: '2', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'status', status: 'active'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '2', body: {events: [{text: 'xin chao'}], sequential_token: 'token2'}, code: 200},
				{type: 'call', call_id: '3', path: '/poll', query: {token: 'token2'}, method: 'get'},
				{type: 'response', call_id: '3', body: '400 dead', code: 400},
				{type: 'status', status: 'dead'},
				{type: 'reconnect'},
				{type: 'wait', timeout: 1000},
				{type: 'call', call_id: 4, path: '/subs'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: 4, body: {initial_token: 'token1'}, code: 200},
				{type: 'status', status: 'active'},
			],
			events: [{text: 'xin chao'}],
		},
		{
			name: 'resub',
			auto_reconnect: true,
			steps: [
				{type: 'subscribe', topics: ['message_sent']},
				{type: 'call', call_id: 1, path: '/subs'},
				{type: 'response', call_id: '1', body: 'wait a sec', code: 500},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 1000},
				{type: 'call', call_id: 2, path: '/subs'},
				{type: 'wait', timeout: 61000},
				{type: 'status', status: 'connecting'},
				{type: 'call', call_id: 3, path: '/subs'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '3', body: 'wait a sec', code: 500},
				{type: 'status', status: 'connecting'},
				{type: 'wait', timeout: 1000},
				{type: 'call', call_id: 4, path: '/subs'},
				{type: 'wait', timeout: 1000},
				{type: 'response', call_id: '4', body: {initial_token: 'token1'}, code: 200},
				{type: 'call', call_id: '5', path: '/poll', query: {token: 'token1'}, method: 'get'},
				{type: 'status', status: 'active'},
				{type: 'response', call_id: '5', body: {events: [{text: 'xin chao'}], sequential_token: 'token2'}, code: 200},
			],
			events: [{text: 'xin chao'}],
		},
	]

	let ps = []
	for (const script of scripts) {
		if (script.name != 'resub') continue
		ps.push(testScript(t, script))
	}
	await Promise.all(ps)
})

let sleep = (ms) => new Promise((rs) => setTimeout(rs, ms))
