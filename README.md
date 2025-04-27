# Subiz wsclient

This library implements subiz long polling protocol

## Method

### subscribe

### onEvent

### stop

## Example

```js
var Realtime = require('@subiz/wsclient')
var realtime = new Realtime('https://realtime-0.subiz.net/', {
	account_id: 'ac1234',
	getAccessToken: () => '333344',
	user_mask: 'mask123',
})

realtime.onEvent((ev) => console.log(ev))

// subscribe events
await realtime.subscribe(['message_sent', 'user_info_updated'])
console.log(realtime.getStatus()) // 'active'

realtime.stop()
```
