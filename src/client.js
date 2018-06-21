class WS {
	// this should be called once, since sendloop will never be terminated
	constructor(options) {
		let defsettings = {
			debug: false,
			reconnectInterval: 1000,
			maxReconnectInterval: 30000,
			reconnectDecay: 1.5,
			timeoutInterval: 10000,
			maxReconnectAttempts: 20,
			commitInterval: 2000,
			pickUrl: done => done(''),
		}
		Object.assign(this, defsettings, options || {})
		this.onconnected = this.onerror = this.onopen = this.onclose = () => {}
		this.msgQ = []
		this.url = ''
		this.connection_id = options.initConnection || ''
		this.reconnectAttempts = -1
		this.sendloop()
		this.reconnect()
	}

	debugInfo(...msg) {
		if (this.debug || WS.debugAll) console.debug('WS', this.url, ...msg)
	}

	sendloop() {
		setInterval(() => {
			if (!this.ws || this.ws.readyState != env.WebSocket.OPEN) return
			if (this.msgQ.length == 0) return
			let max = Math.max(...this.msgQ)
			this.debugInfo('send', max)
			this.ws.send(max + '')
			this.msgQ.length = 0
		}, this.commitInterval)
	}

	commit(offset) { this.msgQ.push(offset) }

	dispatch(eventType, event) {
		this.debugInfo({eventType, event})
		switch (eventType) {
		case 'open':
			this.reconnectAttempts = -1
			return
		case 'close':
			this.onclose(event)
			this.reconnect()
			return
		case 'message':
			let mes = this.parseMessage(event.data)
			if (!mes || mes.error) {
				this.onerror(event, mes.error || 'server error: invalid JSON')
				this.onclose(event)
				this.connection_id = ''
				this.reconnect()
				return
			}

			if (mes.offset != 0) {
				this.onmessage(event, mes.data, mes.offset)
				return
			}
			// first message
			let id = mes && mes.data && mes.data.id || ''
			if (!id) {
				this.onerror(event, 'server error: invalid message format, missing connection id')
				this.onclose(event)
				this.connection_id = ''
				this.reconnect()
				return
			}
			this.connection_id = id
			this.onconnected(undefined, this.connection_id)
			this.onopen(event, this.connection_id)
			return
		case 'error':
			this.onerror(event, event)
			this.onclose(event)
			this.reconnect()
			return
		}
	}

	parseMessage(data) {
		let message
		try {
			message = JSON.parse(data)
			message.data = JSON.parse(message.data)
		} catch(e) {}
		return message
	}

	reconnect() {
		// make sure to kill the last ws
		if (this.ws) this.ws.close()
		this.ws = undefined

		let delay = this.calculateNextBackoff()
		setTimeout(() => {
			if (this.ws) throw "should not hapend, library miss-used"
			if (this.connection_id) this.connect(this.connection_id)
			else this.pickUrl(url => {
				if (this.ws) throw "should not happed, libaray missused"
				this.url = url
				this.connect('')
			})
		}, delay)
		this.reconnectAttempts++
	}

	calculateNextBackoff() {
		if (this.reconnectAttempts == -1) return 0 // first time connect
		let delaytime = this.reconnectInterval * Math.pow(this.reconnectDecay, this.reconnectAttempts)
		return Math.min(this.maxReconnectInterval, delaytime)
	}

	connect(id) {
		if (this.ws) return
		if (id) this.onconnected(undefined, this.connection_id)

		let url = id ? `${this.url}?connection_id=${id}` : this.url
		let ws = this.ws = new env.WebSocket(url)

		let timeout = setTimeout(() => {
			ws = undefined
			this.dispatch('error', 'timeout')
		}, this.timeoutInterval)

		let dispatch = (type, event) => {
			clearTimeout(timeout)
			if (ws && ws === this.ws) this.dispatch(type, event)
		}

		ws.onopen = ev => dispatch('open', ev)
		ws.onclose = ev => dispatch('close', ev)
		ws.onerror = ev => dispatch('error', ev)
		ws.onmessage = ev => dispatch('message', ev)
	}
}

var env = {WebSocket: {}}
module.exports = {WS, env}
