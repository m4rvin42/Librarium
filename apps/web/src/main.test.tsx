import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BookGrid } from './main';
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
