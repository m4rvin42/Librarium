import { useState } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookPhoto, PhotoPicker } from './PhotoPicker';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Harness() {
  const [photos, setPhotos] = useState<BookPhoto[]>([]);
  return <PhotoPicker photos={photos} onChange={setPhotos} />;
}
describe('photo capture queue', () => {
  it('keeps successive camera captures and supports removal', () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    render(<Harness />);
    const camera = screen.getByLabelText('Camera capture');
    for (const role of ['front', 'back'])
      fireEvent.change(camera, {
        target: { files: [new File([role], `${role}.jpg`, { type: 'image/jpeg' })] },
      });
    expect(screen.getByText('2 / 10 photos')).toBeInTheDocument();
    expect(screen.getByLabelText('Photo 1 role')).toHaveValue('front');
    expect(screen.getByLabelText('Photo 2 role')).toHaveValue('back');
    expect(screen.getByLabelText('Existing photos')).not.toHaveAttribute('capture');
    expect(camera).toHaveAttribute('capture', 'environment');
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(screen.getByText('1 / 10 photos')).toBeInTheDocument();
    expect(screen.getByLabelText('Photo 1 role')).toHaveValue('back');
  });
});
