import test from 'node:test'
import assert from 'node:assert/strict'
import { COURSES, firesImmediately, type Course } from './course.ts'

test('COURSES lists exactly the five values the database check constraint allows', () => {
  assert.deepEqual([...COURSES].sort(), ['appetizer', 'beverage', 'dessert', 'main', 'side'])
})
test('a null course (no course set on the product) fires immediately, matching today\'s existing behavior', () => {
  assert.ok(firesImmediately(null))
})
test('appetizer, side and beverage fire immediately; main and dessert are held for explicit firing', () => {
  const immediate: Course[] = ['appetizer', 'side', 'beverage']
  const held: Course[] = ['main', 'dessert']
  for (const course of immediate) assert.ok(firesImmediately(course), `${course} should fire immediately`)
  for (const course of held) assert.ok(!firesImmediately(course), `${course} should be held`)
})
