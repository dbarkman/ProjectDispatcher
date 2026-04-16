import { describe, it, expect } from 'vitest';
import { displayPath } from './display-path.js';

describe('displayPath', () => {
  it('returns path unchanged when no ::archived:: suffix', () => {
    expect(displayPath('/Users/david/Development/ProjectDispatcher')).toBe(
      '/Users/david/Development/ProjectDispatcher',
    );
  });

  it('strips ::archived::<uuid> suffix', () => {
    expect(
      displayPath(
        '/Users/david/Development/ProjectDispatcher::archived::454eb76f-54c2-4d1d-a36e-79663c30e0d0',
      ),
    ).toBe('/Users/david/Development/ProjectDispatcher');
  });

  it('strips only from the first ::archived:: occurrence', () => {
    expect(displayPath('/a/b::archived::x::archived::y')).toBe('/a/b');
  });

  it('handles empty string', () => {
    expect(displayPath('')).toBe('');
  });

  it('handles path ending with ::archived:: and no uuid', () => {
    expect(displayPath('/a/b::archived::')).toBe('/a/b');
  });
});
