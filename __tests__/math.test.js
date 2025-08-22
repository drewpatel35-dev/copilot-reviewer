import { sub, clamp, div } from '../src/math';

test('clamp function', () => {
  expect(clamp(10, 5, 15)).toBe(10);
  expect(clamp(4, 5, 15)).toBe(5);
  expect(() => clamp(10, 15, 5)).toThrow('min>max');
});

test('div function', () => {
  expect(div(10, 2)).toBe(5);
  expect(() => div(10, 0)).toThrow('Cannot divide by zero');
});