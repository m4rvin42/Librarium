import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function AboutContent({ version, failed = false }: { version?: string; failed?: boolean }) {
  return (
    <main className="about-page">
      <img
        className="about-logo"
        src="/librarium-logo.png"
        alt="Librarium seal: an open book beneath an arch"
      />
      <h1>About Librarium</h1>
      <p>Your private library for physical and digital books.</p>
      <dl>
        <dt>Version</dt>
        <dd>{version || (failed ? 'Version unavailable' : 'Loading…')}</dd>
      </dl>
      <a href="https://github.com/m4rvin42/Librarium" target="_blank" rel="noopener noreferrer">
        Librarium on GitHub <span className="muted">(opens in a new tab)</span>
      </a>
    </main>
  );
}

export function About() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ version: string }>('/health'),
  });
  return <AboutContent version={health.data?.version} failed={health.isError} />;
}
