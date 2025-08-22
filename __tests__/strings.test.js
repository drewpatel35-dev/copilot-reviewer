import { isPalindrome, safeJsonParse } from '../src/strings';

test('isPalindrome function', () => {
  expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true);
  expect(isPalindrome('race a car')).toBe(false);
  expect(isPalindrome(123)).toBe(false);
});

test('safeJsonParse function', () => {
  expect(safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
  expect(safeJsonParse('invalid json', 'fallback')).toBe('fallback');
});