import { sub } from '../src/math';

test('subtracts 5 - 2 to equal 3', () => {
  expect(sub(5, 2)).toBe(3);
});