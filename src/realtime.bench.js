var test = require('tape')
const axios = require('axios')
var Realtime = require('./realtime.js')

test('realtime', async t => {
	for (var i = 0; i < 5000; i++) {
		(async function () {
			console.log('I', i)
			var realtime = new Realtime('https://realtime-0.subiz.net/', {
				user_mask: 'acqcsmrppbftadjzxnvo@usqnkpwrkrszjgyfajemn@Iqz40aZ4dwQuvFn8kJA6gqKnyyQLFA0xU44Emw==',
			})
			var err = await realtime.subscribe(['message_pong'])
			t.equal(err, undefined)
		})()
	}
})
