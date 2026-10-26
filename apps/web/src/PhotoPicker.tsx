import { useEffect, useRef, useState } from 'react';

export type BookPhoto = { file: File; role: 'front' | 'back' | 'detail' };
export function CameraInput() {
  const input = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState('No photo selected');
  return (
    <>
      <input
        ref={input}
        name="image"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => setFilename(e.target.files?.[0]?.name || 'No photo selected')}
      />
      <button
        type="button"
        onClick={() => {
          input.current?.setAttribute('capture', 'environment');
          input.current?.click();
        }}
      >
        Take photo
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          input.current?.removeAttribute('capture');
          input.current?.click();
        }}
      >
        Choose existing photo
      </button>
      <span>{filename}</span>
    </>
  );
}
function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <img
      src={url || undefined}
      alt={file.name}
      style={{ width: 100, height: 140, objectFit: 'contain' }}
    />
  );
}

export function PhotoPicker({
  photos,
  onChange,
  disabled = false,
  singleBook = true,
}: {
  photos: BookPhoto[];
  onChange: (photos: BookPhoto[]) => void;
  disabled?: boolean;
  singleBook?: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const requestedRole = useRef<BookPhoto['role'] | null>(null);
  const [error, setError] = useState('');
  function add(input: HTMLInputElement, role: BookPhoto['role'] | null = null) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (photos.length + files.length > 10) {
      setError('You can add up to 10 photos. Remove a photo before adding more.');
      return;
    }
    setError('');
    onChange([
      ...photos,
      ...files.map((file, index) => ({
        file,
        role:
          role ??
          ((photos.length + index === 0
            ? 'front'
            : photos.length + index === 1
              ? 'back'
              : 'detail') as BookPhoto['role']),
      })),
    ]);
  }
  function openCamera(role: BookPhoto['role'] | null) {
    requestedRole.current = role;
    camera.current?.click();
  }
  return (
    <fieldset className="photo-picker" disabled={disabled}>
      <legend>Book photos</legend>
      <input
        ref={camera}
        aria-label="Camera capture"
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          add(e.currentTarget, requestedRole.current);
          requestedRole.current = null;
        }}
      />
      <input
        ref={gallery}
        aria-label="Existing photos"
        hidden
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => add(e.currentTarget)}
      />
      <div className="photo-actions">
        {singleBook ? (
          <>
            <button type="button" onClick={() => openCamera('front')}>
              Take front cover
            </button>
            <button type="button" onClick={() => openCamera('back')}>
              Scan ISBN / back cover
            </button>
          </>
        ) : (
          <button type="button" onClick={() => openCamera(null)}>
            Scan a book
          </button>
        )}
        <button className="secondary" type="button" onClick={() => gallery.current?.click()}>
          Choose existing photos
        </button>
      </div>
      <p>
        {singleBook
          ? 'A clear barcode or printed ISBN is enough when metadata is available. Add a front cover for a better catalog image.'
          : 'Take one photo per book or shelf section. Barcode detection runs before AI analysis.'}
      </p>
      <p>{photos.length} / 10 photos</p>
      {error && <p role="alert">{error}</p>}
      {photos.map((photo, index) => (
        <div key={index}>
          <Preview file={photo.file} />
          <label>
            Photo {index + 1} role{' '}
            <select
              value={photo.role}
              onChange={(e) =>
                onChange(
                  photos.map((p, i) =>
                    i === index ? { ...p, role: e.target.value as BookPhoto['role'] } : p,
                  ),
                )
              }
            >
              <option value="front">Front cover</option>
              <option value="back">Back cover</option>
              <option value="detail">Other detail</option>
            </select>
          </label>
          <button type="button" onClick={() => onChange(photos.filter((_, i) => i !== index))}>
            Remove photo {index + 1}
          </button>
        </div>
      ))}
    </fieldset>
  );
}
