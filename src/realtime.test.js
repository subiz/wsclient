var test = require('tape')
const axios = require('axios')
var Realtime = require('./realtime.js')

function makeMockServer (script) {
	var i = -1
	return (method, url, body, cb) => {
		i++
		script[i](method, url, body, cb)
	}
}

function axiosCall (method, url, body, cb) {
	method = method.toLowerCase()
	return axios[method](url, body).then(resp => cb(resp.rawData, resp.statusCode))
}

test.skip('realtime simple', async t => {
	// var accid = 'acqcsmrppbftadjzxnvo'
	var userid = 'usqnkpwrkrszjgyfajemn'
	var mask = 'acqcsmrppbftadjzxnvo@usqnkpwrkrszjgyfajemn@Iqz40aZ4dwQuvFn8kJA6gqKnyyQLFA0xU44Emw=='

	var realtime = new Realtime({ user_mask: mask }, axiosCall)

	var evid = '-'
	realtime.onEvent(ev => {
		if (ev.data.message.id === evid) {
			realtime.stop()
			t.end()
		}
	})
	realtime.onInterrupted(() => {})
	var err = await realtime.subscribe(['message_pong.account.acqcsmrppbftadjzxnvo.user.usqnkpwrkrszjgyfajemn'])
	t.equal(err, undefined)
	var res = await sendMsg(userid, mask)
	evid = res.data.id
})

test('realtime', async t => {
	var callapi = makeMockServer([
		async (method, url, body, cb) => {
			// must first call sub and must attach user-mask in the query
			t.equal(method, 'post')
			t.true(url.indexOf('/subs?') !== -1)
			t.true(url.indexOf('user-mask=mask123') !== -1)
			cb(`{"initial_token": "token0"}`, 200)
		},
		async (method, url, body, cb) => {
			// start the poll and must attach user-mask in the query
			t.equal(method, 'get')
			t.true(url.indexOf('/poll?') !== -1)
			t.true(url.indexOf('token=token0') !== -1)
			cb(`{"events": [], "sequential_token": "token1"}`, 200)
		},
		async (method, url, body, cb) => {
			// start the poll and must attach user-mask in the query
			t.equal(method, 'get')
			t.true(url.indexOf('/poll?') !== -1)
			t.true(url.indexOf('token=token1') !== -1)
			realtime.stop()
			cb(`{"events": [], "token": "-"}`, 200)
			t.end()
		},
	])

	var realtime = new Realtime({ user_mask: 'mask123' }, callapi)
	var err = await realtime.subscribe(['message_pong'])
	t.equal(err, undefined)
})

function sendMsg (userid, mask, text) {
	if (!text) text = 'hello'
	var ev = {
		by: { id: userid, type: 'user' },
		data: { message: { text, format: 'plaintext' } },
		type: 'message_sent',
	}

	mask = encodeURIComponent(mask)
	var convoid = 'csqohilsfssnkrhnli'
	return axios.post(`https://api.subiz.net/4.0/conversations/${convoid}/messages?x-user-mask=${mask}`, ev)
}
