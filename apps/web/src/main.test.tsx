import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BookGrid, ImageDetectionInfo } from './main';
describe('library grid', () => {
  it('shows an accessible empty state', () => {
    render(
      <MemoryRouter>
        <BookGrid books={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No books here yet.')).toBeInTheDocument();
  });
  it('renders books and authors', () => {
    render(
      <MemoryRouter>
        <BookGrid
          books={[
            {
              id: '1',
              title: 'Dune',
              authors: ['Frank Herbert'],
              readingStatus: 'unread',
              ownershipStatus: 'owned',
              categories: [],
              dateAdded: '',
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Dune' })).toBeInTheDocument();
    expect(screen.getByText('Frank Herbert')).toBeInTheDocument();
  });
});

describe('image detection information', () => {
  it('explains processing and approval on demand', () => {
    render(<ImageDetectionInfo />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /how image detection works/i }));
    expect(screen.getByRole('note')).toHaveTextContent('scanned locally for a barcode first');
    expect(screen.getByRole('note')).toHaveTextContent('Checksums are validated');
    expect(screen.getByRole('note')).toHaveTextContent('until you select and approve');
  });
});
