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
}: {
  photos: BookPhoto[];
  onChange: (photos: BookPhoto[]) => void;
  disabled?: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  function add(input: HTMLInputElement) {
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
        role: (photos.length + index === 0
          ? 'front'
          : photos.length + index === 1
            ? 'back'
            : 'detail') as BookPhoto['role'],
      })),
    ]);
  }
  return (
    <fieldset disabled={disabled}>
      <legend>Book photos</legend>
      <p>
        Take the front cover, then the back cover. Each photo is kept until you remove it. You can
        change its role below.
      </p>
      <input
        ref={camera}
        aria-label="Camera capture"
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => add(e.currentTarget)}
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
      <button type="button" onClick={() => camera.current?.click()}>
        Take photo
      </button>{' '}
      <button type="button" onClick={() => gallery.current?.click()}>
        Choose existing photos
      </button>
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
