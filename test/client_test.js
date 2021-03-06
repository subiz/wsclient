var WebSocket = require('ws')
var client = require('../src/client.js')
client.env.WebSocket = WebSocket

const server = require('./test_server.js').server
var host = 'ws://localhost:8088'
function testServerDown2 (done) {
	var r = Math.random()
	var ws = new client.WS({ pickUrl: done => done(`${host}/3/${r}`) })

	var connid = ''
	var fistconnect = true
	var connected = 0
	ws.onopen = (a, id) => {
		connected++
		connid = id
	}

	var mescount = 0
	ws.onmessage = (a, mes) => {
		mescount++
		if (mescount == 1) {
			if (connected != 1) {
				throw 'invalid connection id'
			}

			if (mes != 1) {
				throw `invalid first message, got ${mes}`
			}
			return
		}
		if (mescount == 2) {
			if (connid != 4) throw 'wrong connid'
			if (connected != 2) throw `wrong connected time, got ${connected}`
			if (closed != 3) throw `wrong closed time, got ${closed}`
			if (errcount != 0) throw `wrong err count, got ${errcount}`
			if (mes != 2) throw `invalid first message, got ${mes}`
			done()
		}
	}

	var closed = 0
	ws.onclose = () => {
		closed++
		if (closed == 1) {
			if (connected != 1) {
				throw 'invalid state'
			}
		}
	}

	var errcount = 0
	ws.onerror = (a, err) => {
		errcount++
	}
}

function testServerDown (done) {
	var r = Math.random()
	var ws = new client.WS({ pickUrl: done => done(`${host}/2/${r}`) })

	var connid = ''
	var fistconnect = true
	var connected = 0
	ws.onopen = (a, id) => {
		connected++
		connid = id
	}

	var mescount = 0
	ws.onmessage = (a, mes) => {
		mescount++
		if (mescount == 1) {
			if (connected != 1) {
				throw 'invalid connection id'
			}

			if (mes != 1) {
				throw `invalid first message, got ${mes}`
			}
			return
		}
		if (mescount == 2) {
			if (connid != 5) throw `wrong connid, got ${connid}`
			if (connected != 2) throw `wrong connected time, got ${connected}`
			if (closed != 4) throw `wrong closed time, got ${closed}`
			if (errcount != 1) throw `wrong err count, got ${errcount}`
			if (mes != 2) throw `invalid first message, got ${mes}`
			done()
		}
	}

	var closed = 0
	ws.onclose = () => {
		closed++
		if (closed == 1) {
			if (connected != 1) {
				throw 'invalid state'
			}
		}
	}

	var errcount = 0
	ws.onerror = (a, err) => {
		errcount++
		if (errcount == 1) {
			if (err != 'dead') {
				throw `invalid error message ${JSON.stringify(err)}`
			}
		}
	}
}

function testNormal (done) {
	var ws = new client.WS({ pickUrl: done => done(`${host}/1`) })
	var connid = ''
	ws.onopen = (a, id) => {
		console.log("a")
		connid = id
	}

	var first = true

	ws.onmessage = (a, mes) => {
		if (first) {
			first = false
			if (connid == '') {
				throw 'invalid connection id'
			}

			if (mes != 1) {
				throw `invalid first message, got ${mes}`
			}
			return
		}

		if (mes != 2) {
			throw `invalid second message, got ${mes}`
		}
		done()
	}
	console.log("b")
}

function main () {
	server.listen(8088, () => {
		var done = 0
		function donecheck () {
			done++
			if (done === 3) {
				console.log('PASS')
				process.exit(0)
			}
		}
		testServerDown(donecheck)
		testServerDown2(donecheck)
		testNormal(donecheck)
	})
}

main()
