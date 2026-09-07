import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index';

describe('contracts package', () => {
  it('exports its application identity', () => {
    expect(APP_NAME).toBe('charge-station');
  });
});
