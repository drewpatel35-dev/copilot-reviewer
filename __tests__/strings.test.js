import { isPalindrome, safeJsonParse, kebabToCamel } from '../src/strings';

test('isPalindrome function', () => {
  expect(isPalindrome('A man, a plan, a canal, Panama')).toBe(true);
  expect(isPalindrome('not a palindrome')).toBe(false);
});

test('safeJsonParse function', () => {
  expect(safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
  expect(safeJsonParse('invalid json', 'fallback')).toBe('fallback');
});

test('kebabToCamel function', () => {
  expect(kebabToCamel('kebab-case')).toBe('kebabCase');
});