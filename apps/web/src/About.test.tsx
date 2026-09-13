import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AboutContent } from './About';
afterEach(cleanup);
describe('About', () => {
  it('shows the installed version, approved logo and repository link', () => {
    render(<AboutContent version="v1.2.3" />);
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/librarium-logo.png');
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/m4rvin42/Librarium',
    );
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('does not invent a version while loading or after failure', () => {
    const view = render(<AboutContent />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    view.rerender(<AboutContent failed />);
    expect(screen.getByText('Version unavailable')).toBeInTheDocument();
  });
});
