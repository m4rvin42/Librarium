import { FormEvent, PointerEvent as ReactPointerEvent, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { api, setCsrf } from './api';
import { BookPhoto, CameraInput, PhotoPicker } from './PhotoPicker';
import './styles.css';

const queryClient = new QueryClient();
const enrichmentFields = [
  'title',
  'subtitle',
  'authors',
  'isbn13',
  'publisher',
  'publicationDate',
  'language',
  'pageCount',
  'description',
  'categories',
  'editionFormat',
  'coverUrl',
] as const;
type Book = {
  id: string;
  title: string;
  subtitle?: string;
  authors: string[];
  coverUrl?: string;
  localCover?: string;
  publisher?: string;
  publicationDate?: string;
  language?: string;
  pageCount?: number;
  description?: string;
  isbn13?: string;
  readingStatus: string;
  ownershipStatus: string;
  editionFormat?: string;
  rating?: number;
  notes?: string;
  categories: string[];
  dateAdded: string;
  readingHistory?: Array<{
    id: string;
    started_date?: string;
    finished_date?: string;
    rating?: number;
    notes?: string;
  }>;
};

type CoverCorner = { x: number; y: number };
type CoverDraft = { id: string; corners: CoverCorner[]; previewUrl: string };

function Login() {
  const [username, setUsername] = useState('admin'),
    [password, setPassword] = useState(''),
    [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await api<any>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setCsrf(result.csrfToken);
      location.reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>Librarium</h1>
        <p>Your private library.</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        {message && <p className="error">{message}</p>}
        <button>Sign in</button>
      </form>
    </main>
  );
}

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/auth/me'), retry: false });
  if (me.isLoading) return <div className="center">Opening Librarium…</div>;
  if (me.isError) return <Login />;
  setCsrf(me.data.csrfToken);
  return (
    <>
      <header>
        <Link className="brand" to="/">
          Librarium
        </Link>
        <nav>
          <NavLink to="/library">Library</NavLink>
          <NavLink to="/add">Add books</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/library" element={<Library />} />
        <Route path="/books/:id" element={<BookDetails />} />
        <Route path="/add" element={<AddBooks />} />
        <Route path="/imports/:id" element={<Review />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </>
  );
}

export function BookGrid({ books }: { books: Book[] }) {
  if (!books.length) return <div className="empty">No books here yet.</div>;
  return (
    <div className="book-grid">
      {books.map((book) => (
        <Link className="book-card" to={`/books/${book.id}`} key={book.id}>
          {book.localCover ? (
            <img src={`/api/v1/books/${book.id}/cover`} alt="" />
          ) : book.coverUrl ? (
            <img src={book.coverUrl} alt="" />
          ) : (
            <div className="cover-fallback">L</div>
          )}
          <div>
            <h3>{book.title}</h3>
            <p>{book.authors.join(', ') || 'Unknown author'}</p>
            <small>{book.readingStatus}</small>
          </div>
        </Link>
      ))}
    </div>
  );
}

function Dashboard() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<any>('/dashboard') });
  return (
    <main>
      <div className="heading">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>Your library</h1>
        </div>
        <Link className="button" to="/add">
          Add books
        </Link>
      </div>
      <div className="stats">
        {[
          ['Books', query.data?.total],
          ['Currently reading', query.data?.reading],
          ['Unread', query.data?.unread],
        ].map(([label, value]) => (
          <article key={label}>
            <strong>{value ?? '–'}</strong>
            <span>{label}</span>
          </article>
        ))}
      </div>
      <h2>Recently added</h2>
      <BookGrid books={query.data?.recent || []} />
      <h2>Recently finished</h2>
      {!query.data?.recentlyFinished?.length ? (
        <div className="empty">No completed reading sessions yet.</div>
      ) : (
        <div className="panel">
          {query.data.recentlyFinished.map((session: any) => (
            <p key={session.id}>
              {session.finished_date} · {session.rating ? `${session.rating}/5` : 'Unrated'}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}

function Library() {
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [ownership, setOwnership] = useState(''),
    [category, setCategory] = useState(''),
    [sort, setSort] = useState('dateAdded'),
    [page, setPage] = useState(1),
    [view, setView] = useState('grid');
  const query = useQuery({
    queryKey: ['books', search, status, ownership, category, sort, page],
    queryFn: () =>
      api<any>(
        `/books?search=${encodeURIComponent(search)}&readingStatus=${status}&ownershipStatus=${ownership}&category=${encodeURIComponent(category)}&sort=${sort}&page=${page}`,
      ),
  });
  return (
    <main>
      <div className="heading">
        <div>
          <p className="eyebrow">Collection</p>
          <h1>Library</h1>
        </div>
        <span>{query.data?.total ?? 0} books</span>
      </div>
      <div className="toolbar">
        <input
          aria-label="Search library"
          placeholder="Search title, author, or ISBN"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Reading status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {['unread', 'reading', 'read', 'abandoned', 'reference', 'wishlist'].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <select
          aria-label="Ownership status"
          value={ownership}
          onChange={(e) => {
            setOwnership(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All ownership</option>
          {['owned', 'wishlist', 'loaned_out', 'borrowed'].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <input
          aria-label="Category"
          placeholder="Category"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        />
        <select aria-label="Sort library" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="dateAdded">Recently added</option>
          <option value="title">Title</option>
          <option value="rating">Rating</option>
        </select>
        <button className="secondary" onClick={() => setView(view === 'grid' ? 'list' : 'grid')}>
          {view === 'grid' ? 'List' : 'Grid'} view
        </button>
      </div>
      <div className={view === 'list' ? 'list-view' : ''}>
        <BookGrid books={query.data?.items || []} />
      </div>
      <div className="actions">
        <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of{' '}
          {Math.max(1, Math.ceil((query.data?.total || 0) / (query.data?.limit || 24)))}
        </span>
        <button
          className="secondary"
          disabled={page * (query.data?.limit || 24) >= (query.data?.total || 0)}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </main>
  );
}

function CoverCornerEditor({
  draft,
  onConfirm,
  pending,
}: {
  draft: CoverDraft;
  onConfirm: (corners: CoverCorner[]) => void;
  pending: boolean;
}) {
  const [corners, setCorners] = useState(draft.corners);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const moveCorner = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeCorner === null) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    setCorners((current) =>
      current.map((corner, index) => (index === activeCorner ? { x, y } : corner)),
    );
  };
  return (
    <section className="cover-review">
      <h4>Adjust cover corners</h4>
      <p className="muted">Drag each point onto the cover, then confirm the straightened image.</p>
      <div
        className="cover-corner-editor"
        onPointerMove={moveCorner}
        onPointerUp={() => setActiveCorner(null)}
        onPointerLeave={() => setActiveCorner(null)}
      >
        <img src={draft.previewUrl} alt="Uploaded cover awaiting straightening" />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Cover corner editor">
          <polygon points={corners.map((corner) => `${corner.x},${corner.y}`).join(' ')} />
          {corners.map((corner, index) => (
            <circle
              key={index}
              cx={corner.x}
              cy={corner.y}
              r="0.025"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setActiveCorner(index);
              }}
            />
          ))}
        </svg>
      </div>
      <button onClick={() => onConfirm(corners)} disabled={pending}>
        {pending ? 'Straightening…' : 'Confirm straightened cover'}
      </button>
    </section>
  );
}

function BookDetails() {
  const { id } = useParams(),
    navigate = useNavigate(),
    qc = useQueryClient(),
    [editing, setEditing] = useState(false);
  const [proposal, setProposal] = useState<any>(null);
  const [selectedProposalFields, setSelectedProposalFields] = useState<string[]>([]);
  const [coverDraft, setCoverDraft] = useState<CoverDraft | null>(null);
  const [usePhotoAsCover, setUsePhotoAsCover] = useState(false);
  const query = useQuery({ queryKey: ['book', id], queryFn: () => api<Book>(`/books/${id}`) });
  const remove = useMutation({
    mutationFn: () => api(`/books/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['books'] });
      navigate('/library');
    },
  });
  const save = useMutation({
    mutationFn: (patch: any) =>
      api(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      query.refetch();
      setEditing(false);
    },
  });
  const addSession = useMutation({
    mutationFn: (session: any) =>
      api(`/books/${id}/reading-sessions`, { method: 'POST', body: JSON.stringify(session) }),
    onSuccess: () => query.refetch(),
  });
  const enrich = useMutation({
    mutationFn: (form: FormData) => api<any>(`/books/${id}/enrich`, { method: 'POST', body: form }),
    onSuccess: (result) => {
      setProposal(result.proposal);
      setCoverDraft(result.coverDraft);
      setSelectedProposalFields(
        enrichmentFields.filter(
          (field) => result.proposal?.[field] !== null && result.proposal?.[field] !== undefined,
        ),
      );
      if (result.coverUpdated) query.refetch();
    },
  });
  const confirmCover = useMutation({
    mutationFn: (corners: CoverCorner[]) =>
      api<any>(`/books/${id}/cover-drafts/${coverDraft?.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ corners }),
      }),
    onSuccess: () => {
      setCoverDraft(null);
      query.refetch();
    },
  });
  if (!query.data) return <main>{query.isLoading ? 'Loading…' : 'Book not found'}</main>;
  const b = query.data;
  return (
    <main>
      <Link to="/library">← Library</Link>
      <article className="details">
        {b.localCover ? (
          <img src={`/api/v1/books/${b.id}/cover`} alt="" />
        ) : b.coverUrl ? (
          <img src={b.coverUrl} alt="" />
        ) : (
          <div className="large-cover">L</div>
        )}
        <div>
          <p className="eyebrow">
            {b.editionFormat || 'Book'} · {b.readingStatus}
          </p>
          <h1>{b.title}</h1>
          <h2>{b.authors.join(', ')}</h2>
          <p>{(b as any).description}</p>
          <dl>
            <dt>ISBN</dt>
            <dd>{b.isbn13 || '—'}</dd>
            <dt>Ownership</dt>
            <dd>{b.ownershipStatus}</dd>
            <dt>Categories</dt>
            <dd>{b.categories.join(', ') || '—'}</dd>
            <dt>Rating</dt>
            <dd>{b.rating ? '★'.repeat(b.rating) : 'Not rated'}</dd>
          </dl>
          {b.notes && (
            <section>
              <h3>Notes</h3>
              <p>{b.notes}</p>
            </section>
          )}
          <section>
            <h3>Reading history</h3>
            {!b.readingHistory?.length && <p className="muted">No reading sessions yet.</p>}
            {b.readingHistory?.map((session) => (
              <p key={session.id}>
                {session.started_date || 'Unknown start'} → {session.finished_date || 'In progress'}
                {session.rating ? ` · ${'★'.repeat(session.rating)}` : ''}
              </p>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                addSession.mutate({
                  startedDate: f.get('startedDate') || null,
                  finishedDate: f.get('finishedDate') || null,
                });
              }}
            >
              <div className="toolbar">
                <label>
                  Started
                  <input name="startedDate" type="date" />
                </label>
                <label>
                  Finished
                  <input name="finishedDate" type="date" />
                </label>
              </div>
              <button className="secondary">Add reading session</button>
            </form>
          </section>
          {editing && (
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                save.mutate({
                  title: f.get('title'),
                  subtitle: f.get('subtitle') || null,
                  authors: String(f.get('authors') || '')
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  publisher: f.get('publisher') || null,
                  publicationDate: f.get('publicationDate') || null,
                  language: f.get('language') || null,
                  pageCount: f.get('pageCount') ? Number(f.get('pageCount')) : null,
                  description: f.get('description') || null,
                  isbn13: f.get('isbn13') || null,
                  coverUrl: f.get('coverUrl') || null,
                  editionFormat: f.get('editionFormat') || null,
                  categories: String(f.get('categories') || '')
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  readingStatus: f.get('readingStatus'),
                  ownershipStatus: f.get('ownershipStatus'),
                  rating: f.get('rating') ? Number(f.get('rating')) : null,
                  notes: f.get('notes'),
                });
              }}
            >
              <label>
                Title
                <input name="title" defaultValue={b.title} required />
              </label>
              <label>
                Authors
                <input name="authors" defaultValue={b.authors.join(', ')} />
              </label>
              <label>
                ISBN-13
                <input name="isbn13" defaultValue={b.isbn13} />
              </label>
              <label>
                Subtitle
                <input name="subtitle" defaultValue={b.subtitle} />
              </label>
              <label>
                Publisher
                <input name="publisher" defaultValue={(b as any).publisher} />
              </label>
              <label>
                Publication date
                <input name="publicationDate" defaultValue={b.publicationDate} />
              </label>
              <label>
                Language
                <input name="language" defaultValue={b.language} />
              </label>
              <label>
                Pages
                <input name="pageCount" type="number" min="1" defaultValue={b.pageCount} />
              </label>
              <label>
                Edition format
                <input name="editionFormat" defaultValue={b.editionFormat} />
              </label>
              <label>
                Remote cover URL
                <input name="coverUrl" type="url" defaultValue={b.coverUrl} />
              </label>
              <label>
                Description
                <textarea name="description" defaultValue={b.description} />
              </label>
              <label>
                Categories
                <input name="categories" defaultValue={b.categories.join(', ')} />
              </label>
              <label>
                Reading status
                <select name="readingStatus" defaultValue={b.readingStatus}>
                  {['unread', 'reading', 'read', 'abandoned', 'reference', 'wishlist'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                Ownership
                <select name="ownershipStatus" defaultValue={b.ownershipStatus}>
                  {['owned', 'wishlist', 'loaned_out', 'borrowed'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                Rating
                <input name="rating" type="number" min="1" max="5" defaultValue={b.rating} />
              </label>
              <label>
                Notes
                <textarea name="notes" defaultValue={b.notes} />
              </label>
              <button>Save changes</button>
            </form>
          )}
          <section className="panel">
            <h3>Enhance from photo</h3>
            <p className="muted">Upload a barcode, spine, copyright page, or front cover.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                enrich.mutate(new FormData(event.currentTarget));
              }}
            >
              <label>
                <input
                  name="useAsCover"
                  type="checkbox"
                  value="true"
                  checked={usePhotoAsCover}
                  onChange={(event) => setUsePhotoAsCover(event.target.checked)}
                />{' '}
                Use this image as the cover
              </label>
              <label>
                <input
                  name="straightenCover"
                  type="checkbox"
                  value="true"
                  onChange={(event) => event.target.checked && setUsePhotoAsCover(true)}
                />{' '}
                Automatically straighten cover
              </label>
              <label>
                Image
                <CameraInput />
              </label>
              <button disabled={enrich.isPending}>
                {enrich.isPending ? 'Analysing…' : 'Analyse photo'}
              </button>
            </form>
            {enrich.error && <p className="error">{enrich.error.message}</p>}
            {coverDraft && (
              <CoverCornerEditor
                key={coverDraft.id}
                draft={coverDraft}
                onConfirm={(corners) => confirmCover.mutate(corners)}
                pending={confirmCover.isPending}
              />
            )}
            {confirmCover.error && <p className="error">{confirmCover.error.message}</p>}
            {proposal && (
              <div>
                <p>Review detected details, then choose what to apply.</p>
                {enrichmentFields
                  .filter((field) => proposal[field] !== null && proposal[field] !== undefined)
                  .map((field) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={selectedProposalFields.includes(field)}
                        onChange={(event) =>
                          setSelectedProposalFields(
                            event.target.checked
                              ? [...selectedProposalFields, field]
                              : selectedProposalFields.filter(
                                  (selectedField) => selectedField !== field,
                                ),
                          )
                        }
                      />
                      {field}:{' '}
                      {Array.isArray(proposal[field])
                        ? proposal[field].join(', ')
                        : proposal[field]}
                    </label>
                  ))}
                <button
                  onClick={() => {
                    const patch = Object.fromEntries(
                      selectedProposalFields.map((field) => [field, proposal[field]]),
                    );
                    save.mutate(patch);
                    setProposal(null);
                  }}
                >
                  Apply selected details
                </button>
              </div>
            )}
          </section>
          <button onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit book'}</button>{' '}
          <button
            className="danger"
            onClick={() => confirm('Delete this book?') && remove.mutate()}
          >
            Delete book
          </button>
        </div>
      </article>
    </main>
  );
}

function AddBooks() {
  const [photos, setPhotos] = useState<BookPhoto[]>([]);
  const [photoMode, setPhotoMode] = useState('single');
  const navigate = useNavigate(),
    [tab, setTab] = useState('isbn'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      if (tab === 'manual') {
        const authors = String(form.get('authors') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        const categories = String(form.get('categories') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        await api('/books', {
          method: 'POST',
          body: JSON.stringify({
            title: form.get('title'),
            subtitle: form.get('subtitle') || null,
            authors,
            isbn13: form.get('isbn13') || null,
            publisher: form.get('publisher') || null,
            publicationDate: form.get('publicationDate') || null,
            language: form.get('language') || null,
            pageCount: form.get('pageCount') ? Number(form.get('pageCount')) : null,
            description: form.get('description') || null,
            categories,
            editionFormat: form.get('editionFormat') || null,
            ownershipStatus: form.get('ownershipStatus'),
            readingStatus: form.get('readingStatus'),
            rating: form.get('rating') ? Number(form.get('rating')) : null,
            notes: form.get('notes') || null,
          }),
        });
        setMessage('Book added.');
      }
      if (tab === 'isbn') {
        const result = await api<any>('/imports/isbn', {
          method: 'POST',
          body: JSON.stringify({ isbn: form.get('isbn') }),
        });
        navigate(`/books/${result.book.id}`);
      }
      if (tab === 'bulk') {
        const result = await api<any>('/imports/isbn/bulk', {
          method: 'POST',
          body: JSON.stringify({ text: form.get('isbns') }),
        });
        setMessage(`Imported ${result.created} of ${result.total} entries.`);
      }
      if (tab === 'images') {
        if (!photos.length) throw new Error('Take a photo or choose existing photos first.');
        const upload = new FormData();
        photos.forEach((photo) =>
          upload.append(photoMode === 'single' ? photo.role : 'images', photo.file),
        );
        const result = await api<any>(
          photoMode === 'single' ? '/imports/book-photos' : '/imports/images',
          { method: 'POST', body: upload },
        );
        navigate(`/imports/${result.id}`);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <p className="eyebrow">Catalog</p>
      <h1>Add books</h1>
      <div className="tabs">
        {['manual', 'isbn', 'bulk', 'images'].map((x) => (
          <button
            className={tab === x ? 'active secondary' : 'secondary'}
            onClick={() => setTab(x)}
            key={x}
          >
            {x}
          </button>
        ))}
      </div>
      <form className="panel" onSubmit={submit}>
        {tab === 'manual' && (
          <>
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Authors, comma separated
              <input name="authors" />
            </label>
            <label>
              Subtitle
              <input name="subtitle" />
            </label>
            <label>
              ISBN-13
              <input name="isbn13" inputMode="numeric" />
            </label>
            <label>
              Publisher
              <input name="publisher" />
            </label>
            <label>
              Publication date
              <input name="publicationDate" />
            </label>
            <label>
              Language
              <input name="language" placeholder="en or de" />
            </label>
            <label>
              Page count
              <input name="pageCount" type="number" min="1" />
            </label>
            <label>
              Format
              <input name="editionFormat" placeholder="Hardcover, ebook…" />
            </label>
            <label>
              Categories, comma separated
              <input name="categories" />
            </label>
            <label>
              Ownership
              <select name="ownershipStatus">
                {['owned', 'wishlist', 'loaned_out', 'borrowed'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Reading status
              <select name="readingStatus">
                {['unread', 'reading', 'read', 'abandoned', 'reference', 'wishlist'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Rating
              <input name="rating" type="number" min="1" max="5" />
            </label>
            <label>
              Description
              <textarea name="description" rows={5} />
            </label>
            <label>
              Notes
              <textarea name="notes" rows={4} />
            </label>
          </>
        )}
        {tab === 'isbn' && (
          <label>
            ISBN-10 or ISBN-13
            <input name="isbn" required placeholder="978…" />
          </label>
        )}
        {tab === 'bulk' && (
          <label>
            Paste ISBNs
            <textarea
              name="isbns"
              rows={9}
              required
              placeholder="One per line, or separated by spaces and commas"
            />
          </label>
        )}
        {tab === 'images' && (
          <>
            <label>
              Photo import mode{' '}
              <select
                value={photoMode}
                disabled={busy}
                onChange={(e) => setPhotoMode(e.target.value)}
              >
                <option value="single">One book — combine front, back and details</option>
                <option value="shelf">
                  Multiple books / shelf — analyse each photo separately
                </option>
              </select>
            </label>
            <p>
              Detected information stays in review until you approve it. Single-book analysis sends
              all selected photos to the configured AI service.
            </p>
            <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
          </>
        )}
        <button disabled={busy}>{busy ? 'Working…' : 'Continue'}</button>
        {message && (
          <p role="status" className={message.includes('Invalid') ? 'error' : ''}>
            {message}
          </p>
        )}
      </form>
    </main>
  );
}

function Review() {
  const { id } = useParams(),
    navigate = useNavigate(),
    qc = useQueryClient(),
    [selected, setSelected] = useState<string[]>([]),
    [editions, setEditions] = useState<Record<string, any>>({});
  const query = useQuery({ queryKey: ['import', id], queryFn: () => api<any>(`/imports/${id}`) });
  const approve = useMutation({
    mutationFn: () =>
      api<any>(`/imports/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ candidateIds: selected, editions }),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      navigate('/library');
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      api(`/imports/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ candidateIds: selected }),
      }),
    onSuccess: () => query.refetch(),
  });
  if (!query.data) return <main>Loading import…</main>;
  const selectedCandidates = query.data.candidates.filter((candidate: any) =>
    selected.includes(candidate.id),
  );
  const missingEdition = selectedCandidates.find(
    (candidate: any) =>
      !candidate.metadata && candidate.alternatives?.length > 1 && !editions[candidate.id],
  );
  const unreadable = selectedCandidates.find(
    (candidate: any) => !candidate.metadata && !candidate.alternatives?.length && !candidate.title,
  );
  return (
    <main>
      <p className="eyebrow">Image import</p>
      <h1>Review detected books</h1>
      <p>Nothing is added until you approve it.</p>
      <div className="import-previews">
        {query.data.images.map((image: any) => (
          <img
            style={{ height: 180, maxWidth: '100%', objectFit: 'contain' }}
            key={image.id}
            src={image.previewUrl}
            alt={image.filename}
          />
        ))}
      </div>
      <div className="candidates">
        {query.data.candidates.map((c: any) => (
          <article className="candidate" key={c.id}>
            <input
              type="checkbox"
              aria-label={`Select ${c.metadata?.title || c.title || 'unreadable candidate'}`}
              checked={selected.includes(c.id)}
              disabled={c.review_status !== 'pending' || c.duplicate}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id),
                )
              }
            />
            <div>
              <h3>{c.metadata?.title || c.title || 'Unreadable title'}</h3>
              <p>{c.metadata?.authors?.join(', ') || c.author || 'Unknown author'}</p>
              {c.metadata?.isbn13 && <p>ISBN: {c.metadata.isbn13}</p>}
              {c.metadata?.description && <p>{c.metadata.description}</p>}
              {c.metadata?._frontImageId && (
                <>
                  <p>Selected local cover:</p>
                  <img
                    alt="Front cover to save"
                    style={{ width: 100 }}
                    src={`/api/v1/imports/${query.data.id}/images/${c.metadata._frontImageId}`}
                  />
                </>
              )}
              <p>
                Confidence {Math.round(c.confidence * 100)}% · Evidence: {c.evidence.join(', ')}
              </p>
              {c.duplicate && <strong className="warning">Already in library</strong>}
              {!c.metadata && c.alternatives?.length > 0 && (
                <select
                  aria-label="Edition"
                  value={editions[c.id]?.metadataSourceId || ''}
                  onChange={(e) => {
                    const edition = c.alternatives.find(
                      (x: any) => x.metadataSourceId === e.target.value,
                    );
                    setEditions({ ...editions, [c.id]: edition });
                  }}
                >
                  <option value="">Choose an edition</option>
                  {c.alternatives.map((x: any) => (
                    <option key={x.metadataSourceId} value={x.metadataSourceId}>
                      {x.title} · {x.publisher || 'Unknown publisher'} ·{' '}
                      {x.publicationDate || 'Unknown date'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </article>
        ))}
      </div>
      {missingEdition && (
        <p role="alert" className="error">
          Choose an edition for “{missingEdition.title}” before approving.
        </p>
      )}
      {unreadable && (
        <p role="alert" className="error">
          An unreadable candidate cannot be approved. Reject it or try another image.
        </p>
      )}
      {approve.error && (
        <p role="alert" className="error">
          Approval failed: {approve.error.message}
        </p>
      )}
      {reject.error && (
        <p role="alert" className="error">
          Rejection failed: {reject.error.message}
        </p>
      )}
      <div className="actions">
        <button
          disabled={
            !selected.length || Boolean(missingEdition) || Boolean(unreadable) || approve.isPending
          }
          onClick={() => approve.mutate()}
        >
          {approve.isPending ? 'Approving…' : 'Approve selected'}
        </button>
        <button className="secondary" disabled={!selected.length} onClick={() => reject.mutate()}>
          Reject selected
        </button>
      </div>
    </main>
  );
}

function Settings() {
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<any>('/settings/status') });
  const credentials = useQuery({
    queryKey: ['api-credentials'],
    queryFn: () => api<any>('/settings/api-credentials'),
  });
  const audit = useQuery({
    queryKey: ['audit-events'],
    queryFn: () => api<any>('/settings/audit-events?limit=20'),
  });
  const trash = useQuery({ queryKey: ['trash'], queryFn: () => api<any>('/trash/books') });
  const [message, setMessage] = useState('');
  const [newToken, setNewToken] = useState('');
  const metadataSettings = useMutation({
    mutationFn: (payload: unknown) =>
      api<any>('/settings/metadata', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  const createApiCredential = useMutation({
    mutationFn: (payload: unknown) =>
      api<any>('/settings/api-credentials', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (result) => {
      setNewToken(result.token);
      void credentials.refetch();
    },
  });
  const revokeApiCredential = useMutation({
    mutationFn: (credentialId: string) =>
      api(`/settings/api-credentials/${credentialId}`, { method: 'DELETE' }),
    onSuccess: () => void credentials.refetch(),
  });
  const recommendationSettings = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/settings/recommendations', {
        method: 'PUT',
        body: JSON.stringify({ openAiRerankingEnabled: enabled }),
      }),
    onSuccess: () => void query.refetch(),
  });
  const restoreTrash = useMutation({
    mutationFn: (bookId: string) => api(`/trash/books/${bookId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      void trash.refetch();
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
  const permanentlyDeleteTrash = useMutation({
    mutationFn: (bookId: string) => api(`/trash/books/${bookId}`, { method: 'DELETE' }),
    onSuccess: () => void trash.refetch(),
  });
  async function jsonImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      file = form.get('file') as File;
    try {
      const document = JSON.parse(await file.text());
      const result = await api<any>('/import/json', {
        method: 'POST',
        body: JSON.stringify({ document, dryRun: true, strategy: 'skip' }),
      });
      setMessage(
        `Dry run: ${result.summary.valid} valid, ${result.summary.conflicts.length} conflicts.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const primary = String(form.get('primaryProvider'));
    const fallback = String(form.get('fallbackProvider'));
    const finalFallback = String(form.get('finalFallbackProvider'));
    const providers = [...new Set([primary, fallback, finalFallback].filter(Boolean))];
    const googleBooksApiKey = String(form.get('googleBooksApiKey') || '').trim();
    try {
      await metadataSettings.mutateAsync({
        providers,
        ...(googleBooksApiKey ? { googleBooksApiKey } : {}),
        clearGoogleBooksApiKey: form.get('clearGoogleBooksApiKey') === 'on',
      });
      setMessage('Metadata settings saved.');
      event.currentTarget.reset();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scopes = form.getAll('scopes').map(String);
    try {
      await createApiCredential.mutateAsync({ name: String(form.get('name')), scopes });
      event.currentTarget.reset();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  const metadata = query.data?.metadata;
  const providers = metadata?.providers ?? ['openlibrary'];
  return (
    <main>
      <p className="eyebrow">Administration</p>
      <h1>Settings & backup</h1>
      <div className="settings-grid">
        <section className="panel">
          <h2>Feature status</h2>
          <dl>
            <dt>Metadata</dt>
            <dd>{providers.join(' → ')}</dd>
            <dt>Google Books key</dt>
            <dd>{metadata?.googleBooksKeyConfigured ? 'Configured' : 'Not configured'}</dd>
            <dt>OpenAI web search</dt>
            <dd>
              {metadata?.openAiWebSearchConfigured
                ? `Configured (${metadata.openAiMetadataModel})`
                : 'OpenAI API key not configured'}
            </dd>
            <dt>Image analysis</dt>
            <dd>
              {query.data?.imageAnalysis.enabled
                ? `Enabled (${query.data.imageAnalysis.model})`
                : 'Disabled'}
            </dd>
          </dl>
        </section>
        <form className="panel" onSubmit={saveMetadata} key={providers.join(',')}>
          <h2>ISBN metadata</h2>
          <label>
            Primary provider
            <select name="primaryProvider" defaultValue={providers[0]}>
              <option value="openlibrary">Open Library</option>
              <option value="googlebooks">Google Books</option>
              <option value="openai-web-search">OpenAI web search</option>
            </select>
          </label>
          <label>
            Fallback provider
            <select name="fallbackProvider" defaultValue={providers[1] ?? ''}>
              <option value="">None</option>
              <option value="openlibrary">Open Library</option>
              <option value="googlebooks">Google Books</option>
              <option value="openai-web-search">OpenAI web search</option>
            </select>
          </label>
          <label>
            Final fallback provider
            <select name="finalFallbackProvider" defaultValue={providers[2] ?? ''}>
              <option value="">None</option>
              <option value="openlibrary">Open Library</option>
              <option value="googlebooks">Google Books</option>
              <option value="openai-web-search">OpenAI web search</option>
            </select>
          </label>
          <label>
            Google Books API key
            <input name="googleBooksApiKey" type="password" autoComplete="off" />
          </label>
          <label>
            <input name="clearGoogleBooksApiKey" type="checkbox" /> Clear saved Google Books key
          </label>
          {!metadata?.editable && (
            <p className="muted">Set SETTINGS_ENCRYPTION_KEY to save a Google Books key here.</p>
          )}
          <p className="muted">
            OpenAI web search sends the ISBN to OpenAI and its search service when selected.
          </p>
          <button disabled={metadataSettings.isPending}>
            {metadataSettings.isPending ? 'Saving…' : 'Save metadata settings'}
          </button>
        </form>
        <section className="panel">
          <h2>Recommendation privacy</h2>
          <p>
            Local ranking is always available. Optional OpenAI reranking sends book metadata and
            ratings, never notes, reading-session text, credentials, or images.
          </p>
          <label>
            <input
              type="checkbox"
              checked={Boolean(query.data?.recommendations.openAiRerankingEnabled)}
              disabled={
                !query.data?.recommendations.openAiConfigured || recommendationSettings.isPending
              }
              onChange={(event) => recommendationSettings.mutate(event.target.checked)}
            />{' '}
            Enable OpenAI reranking ({query.data?.recommendations.model || 'not configured'})
          </label>
        </section>
        <form className="panel" onSubmit={createToken}>
          <h2>Assistant credentials</h2>
          <label>
            Name
            <input name="name" placeholder="Private assistant" required maxLength={100} />
          </label>
          {[
            'library:read',
            'books:write',
            'reading:write',
            'imports:write',
            'books:delete',
            'notes:read',
            'notes:write',
          ].map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                name="scopes"
                value={scope}
                defaultChecked={!scope.startsWith('notes:')}
              />{' '}
              {scope}
            </label>
          ))}
          <button disabled={createApiCredential.isPending}>Create credential</button>
          {newToken && (
            <div role="status">
              <strong>Copy this token now; it will not be shown again.</strong>
              <pre>{newToken}</pre>
              <button
                type="button"
                className="secondary"
                onClick={() => navigator.clipboard.writeText(newToken)}
              >
                Copy token
              </button>{' '}
              <button type="button" className="secondary" onClick={() => setNewToken('')}>
                Dismiss
              </button>
            </div>
          )}
          {credentials.data?.items.map((credential: any) => (
            <p key={credential.id}>
              <strong>{credential.name}</strong> · {credential.tokenPrefix} ·{' '}
              {credential.revokedAt ? 'revoked' : credential.scopes.join(', ')}{' '}
              {!credential.revokedAt && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => revokeApiCredential.mutate(credential.id)}
                >
                  Revoke
                </button>
              )}
            </p>
          ))}
        </form>
        <section className="panel">
          <h2>Trash</h2>
          {!trash.data?.items.length && <p className="muted">Trash is empty.</p>}
          {trash.data?.items.map((book: any) => (
            <p key={book.id}>
              {book.title}{' '}
              <button className="secondary" onClick={() => restoreTrash.mutate(book.id)}>
                Restore
              </button>{' '}
              <button
                className="secondary"
                onClick={() => {
                  if (window.confirm(`Permanently delete “${book.title}”? This cannot be undone.`))
                    permanentlyDeleteTrash.mutate(book.id);
                }}
              >
                Delete permanently
              </button>
            </p>
          ))}
        </section>
        <section className="panel">
          <h2>Recent API activity</h2>
          {!audit.data?.items.length && <p className="muted">No assistant activity yet.</p>}
          {audit.data?.items.map((event: any) => (
            <p key={event.id}>
              <strong>{event.credentialName || event.actorType}</strong> · {event.operation} ·{' '}
              {event.statusCode}
            </p>
          ))}
        </section>
        <section className="panel">
          <h2>Download backup</h2>
          <p>JSON is portable. SQLite preserves the complete database.</p>
          <a className="button" href="/api/v1/export/json">
            Download JSON
          </a>{' '}
          <a className="button secondary" href="/api/v1/export/sqlite">
            Download SQLite
          </a>
        </section>
        <form className="panel" onSubmit={jsonImport}>
          <h2>Import JSON</h2>
          <label>
            Export file
            <input name="file" type="file" accept="application/json" required />
          </label>
          <button>Validate dry run</button>
          {message && <p>{message}</p>}
        </form>
      </div>
      {message && <p className="muted">{message}</p>}
      <p className="muted">
        SQLite restore is available through the authenticated API and requires the explicit RESTORE
        confirmation header.
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
