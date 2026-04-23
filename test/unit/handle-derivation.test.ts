import { describe, test, expect } from 'vitest';
import { deriveBaseHandle, handleVariant, isSameUser } from '../../channel/handle';

describe('deriveBaseHandle', () => {
  test('strips domain and @ prefixes', () => {
    expect(deriveBaseHandle('arvind@example.com')).toBe('@arvind');
  });

  test('removes dots and other punctuation from local-part', () => {
    expect(deriveBaseHandle('arvind.naidu@gmail.com')).toBe('@arvindnaidu');
    expect(deriveBaseHandle('arvind+tag@gmail.com')).toBe('@arvindtag');
    expect(deriveBaseHandle('arvind_naidu@gmail.com')).toBe('@arvindnaidu');
    expect(deriveBaseHandle('arvind-naidu@gmail.com')).toBe('@arvindnaidu');
  });

  test('lowercases the result', () => {
    expect(deriveBaseHandle('ARVIND@GMAIL.COM')).toBe('@arvind');
    expect(deriveBaseHandle('Arvind.Naidu@Gmail.com')).toBe('@arvindnaidu');
  });

  test('different emails with same local-part produce identical handles', () => {
    // This is the collision case the retry loop is built to handle.
    expect(deriveBaseHandle('arvind.naidu@gmail.com')).toBe(
      deriveBaseHandle('arvindnaidu@work.com'),
    );
    expect(deriveBaseHandle('arvind.naidu@gmail.com')).toBe(
      deriveBaseHandle('Arvind.Naidu@Yahoo.com'),
    );
  });

  test('numeric-only local-part is preserved', () => {
    expect(deriveBaseHandle('123@example.com')).toBe('@123');
  });
});

describe('handleVariant', () => {
  test('attempt 1 returns the base unchanged', () => {
    expect(handleVariant('@arvind', 1)).toBe('@arvind');
  });

  test('attempts 2+ append the attempt number', () => {
    expect(handleVariant('@arvind', 2)).toBe('@arvind2');
    expect(handleVariant('@arvind', 3)).toBe('@arvind3');
    expect(handleVariant('@arvind', 10)).toBe('@arvind10');
  });

  test('attempt 0 and negative values behave as attempt 1', () => {
    expect(handleVariant('@arvind', 0)).toBe('@arvind');
    expect(handleVariant('@arvind', -5)).toBe('@arvind');
  });
});

describe('isSameUser (auth.json fast-path match)', () => {
  test('null/undefined saved auth is never the same user', () => {
    expect(isSameUser(null, 'x@y.com', '@x')).toBe(false);
    expect(isSameUser(undefined, 'x@y.com', '@x')).toBe(false);
    expect(isSameUser({}, 'x@y.com', '@x')).toBe(false);
  });

  test('email match wins even when the handle looks different', () => {
    // This is the point of the whole change: a collision user lands on
    // @arvind2, but logging in again with the same email should still
    // match them as the same user.
    expect(
      isSameUser(
        { handle: '@arvind2', email: 'a@b.com' },
        'a@b.com',
        '@arvind',
      ),
    ).toBe(true);
  });

  test('different email on saved auth is a different user', () => {
    expect(
      isSameUser(
        { handle: '@joe', email: 'joe@a.com' },
        'joe@b.com',
        '@joe',
      ),
    ).toBe(false);
  });

  test('legacy auth (no email): handle match is accepted', () => {
    expect(
      isSameUser({ handle: '@arvind' }, 'a@b.com', '@arvind'),
    ).toBe(true);
  });

  test('legacy auth (no email): handle mismatch is rejected', () => {
    // Old behavior — if saved handle does not match the derived one, we
    // treat it as a different user and force fresh login.
    expect(
      isSameUser({ handle: '@arvind2' }, 'a@b.com', '@arvind'),
    ).toBe(false);
  });

  test('saved email takes priority: handle match is ignored when emails differ', () => {
    expect(
      isSameUser(
        { handle: '@x', email: 'one@a.com' },
        'two@a.com',
        '@x',
      ),
    ).toBe(false);
  });
});
