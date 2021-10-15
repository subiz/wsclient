var test = require('tape')
var Realtime = require('./realtime.js')

function makeMockServer(script) {
	var i = -1
	return (method, url, body, cb) => {
		i++
		script[i](method, url, body, cb)
	}
}

test('realtime', async (t) => {
	var callapi = makeMockServer([
		async (method, url, body, cb) => {
			// must first call sub and must attach user-mask in the query
			t.equal(method, 'post')
			t.true(url.indexOf('subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`{"initial_token": "token0"}`, 200)
		},
		async (method, url, body, cb) => {
			// start the poll and must attach initial token  in the query
			t.equal(method, 'get')
			t.true(url.indexOf('poll?') !== -1)
			t.true(url.indexOf('token=token0') !== -1)
			cb(`{"events": [], "sequential_token": "token1"}`, 200)
		},
		async (method, url, body, cb) => {
			// next poll must attach last received token
			t.equal(method, 'get')
			t.true(url.indexOf('poll?') !== -1)
			t.true(url.indexOf('token=token1') !== -1)
			realtime.stop()
			cb(`{"events": [], "token": "-"}`, 200)
		},
	])

	var realtime = new Realtime('', {user_mask: 'mask123'}, callapi)
	var err = await realtime.subscribe(['message_pong'])
	t.true(Object.keys(err).length === 0)
})

test('realtime subs when server down and then backup', async (t) => {
	var callapi = makeMockServer([
		async (method, url, body, cb) => {
			// must first call sub and must attach user-mask in the query
			t.equal(method, 'post')
			t.true(url.indexOf('subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`502 too busy`, 502)
		},
		async (method, url, body, cb) => {
			// should retry
			t.equal(method, 'post')
			t.true(url.indexOf('subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`502 still busy`, 502)
		},
		async (method, url, body, cb) => {
			// should retry
			t.equal(method, 'post')
			t.true(url.indexOf('subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`{"initial_token": "token0"}`, 200)
		},
		async (method, url, body, cb) => {
			t.equal(method, 'get')
			t.true(url.indexOf('poll?') !== -1)
			t.true(url.indexOf('token=token0') !== -1)
			realtime.stop()
			cb(`{"events": [], "token": "-"}`, 200)
		},
	])

	var realtime = new Realtime('', {user_mask: 'mask123'}, callapi)
	var err = await realtime.subscribe(['message_pong'])
	t.true(Object.keys(err).length === 0)
})

test('realtime must stop if there is something wrong with our credential or our code', async (t) => {
	var subcode
	var callapi = makeMockServer([
		async (method, url, bkody, cb) => {
			// must first call sub and must attach user-mask in the query
			t.equal(method, 'post')
			t.true(url.indexOf('subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`400 invalid mask`, 400)
			realtime.stop()
		},
	])

	var realtime = new Realtime('', {user_mask: 'mask123'}, callapi)
	realtime.onInterrupted((_, _1, code) => {
		subcode = code
	})
	var err = await realtime.subscribe(['message_pong'])
	t.false(Object.keys(err).length === 0)
})
