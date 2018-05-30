'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var WS = function () {
	function WS(options) {
		_classCallCheck(this, WS);

		this.onerror = this.onopen = this.onclose = this.ondead = function () {};
		var defsettings = {
			debug: false,
			reconnectInterval: 1000,
			maxReconnectInterval: 30000,
			reconnectDecay: 1.5,
			timeoutInterval: 10000,
			maxReconnectAttempts: 20,
			pickUrl: function pickUrl(done) {
				return done('');
			}
		};
		Object.assign(this, defsettings, options || {});
		this.dead = false;
		this.msgQ = [];
		this.url = '';
		this.connection_id = '';
		this.reconnectAttempts = 0;
		this.sendloop();
		this.reconnect();
	}

	_createClass(WS, [{
		key: 'halt',
		value: function halt() {
			this.dead = true;
			if (this.ws) this.ws.close();
		}
	}, {
		key: 'debugInfo',
		value: function debugInfo() {
			var _console;

			for (var _len = arguments.length, msg = Array(_len), _key = 0; _key < _len; _key++) {
				msg[_key] = arguments[_key];
			}

			if (this.debug || WS.debugAll) (_console = console).debug.apply(_console, ['WS', this.url].concat(msg));
		}
	}, {
		key: 'sendloop',
		value: function sendloop() {
			var _this = this;

			var handler = setInterval(function () {
				if (_this.dead) {
					clearInterval(handler);
					return;
				}
				if (!_this.ws || _this.ws.readyState != env.WebSocket.OPEN) return;
				if (_this.msgQ.length == 0) return;
				var max = _this.msgQ.reduce(function (a, b) {
					return a > b ? a : b;
				});
				if (!max) return;
				_this.debugInfo('send', max);
				_this.ws.send(max);
				_this.msgQ.length = 0;
			}, 1000);
		}
	}, {
		key: 'commit',
		value: function commit(offset) {
			this.msgQ.push(offset);
		}
	}, {
		key: 'dispatch',
		value: function dispatch(eventType, event) {
			this.debugInfo({ eventType: eventType, event: event });
			switch (eventType) {
				case 'open':
					this.reconnectAttempts = 0;
					break;
				case 'close':
					this.onclose(event);
					this.reconnect();
					break;
				case 'message':
					var mes = this.parseMessage(event.data);
					if (!mes) {
						this.onerror(event, 'server error: invalid JSON');
						this.onclose(event);
						this.connection_id = '';
						this.reconnect();
						return;
					}

					if (mes.error) {
						this.onerror(event, mes.error);
						this.onclose(event);
						this.connection_id = '';
						this.reconnect();
						return;
					}
					if (mes.offset == 0) {
						// first message
						var id = mes && mes.data && mes.data.id || '';
						if (!id) {
							this.onerror(event, 'server error: invalid message format, missing connection id');
							this.onclose(event);
							this.connection_id = '';
							this.reconnect();
							return;
						}
						this.connection_id = id;
						this.onopen(event, this.connection_id);
						return;
					}
					this.onmessage(event, mes.data, mes.offset);
					break;
				case 'error':
					this.onerror(event, event);
					this.onclose(event);
					this.reconnect();
					break;
				case 'timeout':
					this.onerror(event, 'cannot connect');
					this.onclose(event);
					this.reconnect();
					break;
				case 'outdated':
					this.ondead(event);
					this.halt();
					break;
			}
		}
	}, {
		key: 'parseMessage',
		value: function parseMessage(data) {
			var message = void 0;
			try {
				message = JSON.parse(data);
				message.data = JSON.parse(message.data);
			} catch (e) {}
			return message;
		}
	}, {
		key: 'reconnect',
		value: function reconnect() {
			var _this2 = this;

			// make sure to kill the last ws
			if (this.ws) this.ws.close();
			this.ws = undefined;

			if (this.reconnectAttempts > this.maxReconnectAttempts) {
				this.dispatch('outdated');
				return;
			}
			var delay = this.calculateNextBackoff();
			setTimeout(function () {
				if (_this2.ws) throw "should not hapend, library miss-used";
				if (_this2.connection_id) _this2.connect(_this2.connection_id);else _this2.pickUrl(function (url) {
					if (_this2.ws) throw "should not happed, libaray missused";
					_this2.url = url;
					_this2.connect('');
				});
			}, delay);
			this.reconnectAttempts++;
		}
	}, {
		key: 'calculateNextBackoff',
		value: function calculateNextBackoff() {
			var delaytime = this.reconnectInterval * Math.pow(this.reconnectDecay, this.reconnectAttempts);
			return delaytime > this.maxReconnectInterval ? this.maxReconnectInterval : delaytime;
		}
	}, {
		key: 'connect',
		value: function connect(id) {
			var _this3 = this;

			if (this.ws || this.dead) return;
			var url = id ? this.url + '?connection_id=' + id : this.url;
			var ws = this.ws = new env.WebSocket(url);

			var timeout = setTimeout(function () {
				ws = undefined;
				_this3.dispatch('timeout', id);
			}, this.timeoutInterval);

			var dispatch = function dispatch(type, event) {
				clearTimeout(timeout);
				if (ws && ws === _this3.ws) _this3.dispatch(type, event);
			};

			ws.onopen = function (ev) {
				return dispatch('open', ev);
			};
			ws.onclose = function (ev) {
				return dispatch('close', ev);
			};
			ws.onerror = function (ev) {
				return dispatch('error', ev);
			};
			ws.onmessage = function (ev) {
				return dispatch('message', ev);
			};
		}
	}]);

	return WS;
}();

var env = { WebSocket: {} };
module.exports = { WS: WS, env: env };