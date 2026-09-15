'use client';

import dynamic from 'next/dynamic';

const SamvahakLive = dynamic(() => import('./components/SamvahakLive'), {
  ssr: false,
});

export default function Home() {
  return (
    <main className="h-screen w-screen bg-slate-950 p-4">
      <SamvahakLive mapboxToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN} />
    </main>
  );
}