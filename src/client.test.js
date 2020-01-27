var test = require('tape')
var client = require('./client.js')

test('sized set', t => {
	var set = new client.SizedSet(5)
	set.add(1)
	set.add(3)
	set.add(2)
	set.add(5)
	set.add(4)

	t.true(set.has(1))
	t.true(set.has(3))
	t.true(set.has(2))
	t.true(set.has(5))
	t.true(set.has(4))

	set.add(6) // set is full, must remove the first key
	t.false(set.has(1))
	t.true(set.has(3))
	t.true(set.has(2))
	t.true(set.has(5))
	t.true(set.has(4))
	t.true(set.has(6))

	set.add(7) // continue to delete key
	t.false(set.has(3))
	t.true(set.has(2))
	t.true(set.has(5))
	t.true(set.has(4))
	t.true(set.has(6))
	t.true(set.has(7))

	t.end()
})
