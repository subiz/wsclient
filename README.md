# Subiz wsclient

This library implements the Subiz long polling protocol. It keeps a realtime
connection to the Subiz realtime server, lets you subscribe to event topics and
delivers new events to you as fast as possible.

It also ships a `WebPhone` client (built on top of the realtime connection and
WebRTC) for making and answering calls in the browser.

## Install

```sh
npm install @subiz/wsclient
```

## Realtime

```js
var Realtime = require('@subiz/wsclient')

var realtime = new Realtime('https://api.subiz.com.vn/rt/0/', {
	account_id: 'ac1234',
	getAccessToken: () => Promise.resolve('333344'),
})

realtime.onEvent((ev) => console.log(ev))

// subscribe events
await realtime.subscribe(['message_sent', 'user_info_updated'])
console.log(realtime.getStatus()) // 'active'

realtime.stop()
```

### new Realtime(apiUrls, credential, [callAPI], [accid], [skipautoreconnect])

- `apiUrls`: a realtime endpoint (string) or a list of endpoints, each must end
  with `/`. When a list is given, one endpoint is picked at random per
  connection.
- `credential`: `{account_id, getAccessToken, user_ref, user_mask}`.
  `getAccessToken` should return a Promise resolving to the access token
  (returning a plain string also works). `user_ref` or `user_mask` are used
  instead of the access token when present.
- `callAPI` (optional): custom HTTP function `(method, url, body, cb)` used
  instead of the built-in XHR, mainly for testing.
- `accid` (optional): account id, defaults to `credential.account_id`.
- `skipautoreconnect` (optional): when true, the connection is not recreated
  automatically after it dies.

The connection auto-reconnects 2 seconds after it dies and resubscribes all
previously subscribed topics. Polling is throttled to at most 4 requests per
second even if the server misbehaves and answers instantly.

### Browser page exit

In a browser, each active `Realtime` instance listens for `pagehide`. When the
page is discarded (closing a tab, reloading, or navigating away), it sends a
best-effort `POST` to `cleanup` on the latest realtime host, with the latest
sequential token and account ID. It uses `navigator.sendBeacon`; if unavailable,
rejected, or throwing, it falls back to `fetch` with `keepalive: true`. Cleanup
uses the last subscription credentials and never waits for an access-token
refresh while the page exits. These requests use the browser transport directly,
not the optional `callAPI` hook.

The exiting instance stops polling and cancels pending auto-reconnects. A new
page creates a new subscription; it must not reuse the cleaned connection's
token. No cleanup is sent for network loss, a hidden/background tab, or
`pagehide` with `persisted: true` (the page may return from the back/forward
cache). Node.js and native runtimes without a browser document do not install
this listener. `stop()` removes the listener; an explicit `reconnect()` attaches
it again while the page is still open.

Browser exit notifications are not guaranteed, especially when a browser is
force-closed. If no token has been received yet or cleanup cannot be delivered,
the server's existing two-minute connection expiry remains the fallback. See
[pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)
and [sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon).

### subscribe(topics)

Tells the server we are listening for those topics. `topics` is a string or an
array of strings. Already-subscribed topics are skipped, so it is safe to call
multiple times. Calls are batched (up to 50 topics per request).

Returns a Promise resolving to `{}` on success or `{error}` on failure.

### onEvent(callback)

Registers a callback that is called with each incoming event.

### onInterrupted(callback)

Registers a callback that is called whenever the connection dies (before an
automatic reconnect) or is stopped.

### getStatus()

Returns the current connection status: `'active'`, `'connecting'` (having
trouble reaching the server, retrying) or `'dead'`.

### stop()

Kills the connection and disables auto-reconnect. Call `reconnect()` to start
a new connection again.

### reconnect()

Drops the current connection (if any), creates a new one and resubscribes all
topics. Returns the resubscribe Promise.

## WebPhone

```js
var WebPhone = require('@subiz/wsclient/webphone.js')

var phone = new WebPhone('ac1234_ag5678_...') // agent access token

phone.onEvent((ev) => console.log(ev.type, ev.data.call_info))

// outbound call, the from-number is picked from the account's activated
// call integrations, and automatically falls back to the next number when
// the call fails
var call = await phone.makeCall('84900000000')

// or force specific from-numbers
await phone.makeCall('84900000000', ['84911111111', '84922222222'])

phone.sendDtmf('1', callid)
phone.transferCall('84933333333', callid)
phone.hangupCall(callid)

// inbound: answer a ringing call
await phone.answerWebCall(callid)
```

### new WebPhone(access_token, [realtime])

`access_token` must be an agent token of the form `ac..._ag..._...`. A
`Realtime` instance is created automatically unless you pass your own.
An invisible `<audio>` tag is appended to the document to play the remote
audio.

### Methods

- `makeCall(number, [fromnumbers], [streamPm])`: starts an outbound call and
  returns a Promise resolving to the ended call object. `fromnumbers` is a
  number, a string or an array of numbers to call from (defaults to all
  activated call integrations). On `terminated`/`failure`/`congestion` the
  call is retried with the next from-number until none is left (then it
  resolves with the last failed result, or `error: 'out_of_number'` when
  there was no number to call from at all).
- `answerWebCall(callid)`: asks for microphone permission and answers an
  incoming call.
- `hangupCall([callid])`: hangs up the given call, defaults to the current
  call.
- `sendDtmf(key, callid)`: sends a DTMF key press.
- `transferCall(number, callid)`: transfers the call to another number.
- `onEvent(callback)`: subscribes to call events (`call_ringing`,
  `call_ended`, ...).
- `getCall(callid)` / `getCurrentCall()` / `getCurrentCallId()`: look up call
  state.
- `isMicAllowed()`: resolves to `true`/`false` whether microphone access is
  granted.
- `checkMic()`: returns `{timeout, result}` promises for microphone
  permission, `timeout` resolves with `'Not_authorized'` after 500ms if the
  user has not decided yet.
- `getMicroStream()`: returns the current microphone `MediaStream` if any.
