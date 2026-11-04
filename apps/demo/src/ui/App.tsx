import { useEffect, useState } from 'react';
import { DEVICE_LABEL, DEVICES, deviceOf, type Device } from '../station';
import { DemoWorld, type EngineChoice } from '../world';
import { Footer } from './Footer';
import { Panel } from './Panel';
import { SyncLog } from './SyncLog';
import { Topology } from './Topology';

/** Build the first world. ?engine=naive, ?play=1 and ?at=<ms> make screenshots reproducible. */
function initialWorld(engine: EngineChoice): DemoWorld {
  const params = new URLSearchParams(location.search);
  const world = new DemoWorld(engine);
  if (params.get('play')) world.play();
  const at = Number(params.get('at'));
  if (at > 0) world.advanceTo(at);
  return world;
}

/** Advance simulated time with real time, and re-render a few times a second. */
function useDriver(world: DemoWorld): void {
  const [, setFrame] = useState(0);
  useEffect(() => {
    const start = performance.now() - world.now;
    const timer = setInterval(() => {
      world.advanceTo(performance.now() - start);
      setFrame((f) => f + 1);
    }, 50);
    return () => clearInterval(timer);
  }, [world]);
}

export function App() {
  const [engine, setEngine] = useState<EngineChoice>(() =>
    new URLSearchParams(location.search).get('engine') === 'naive' ? 'naive' : 'crdt',
  );
  const [world, setWorld] = useState(() => initialWorld(engine));
  useDriver(world);

  const restart = (next: EngineChoice, play: boolean) => {
    const fresh = new DemoWorld(next);
    if (play) fresh.play();
    setWorld(fresh);
  };
  const switchEngine = (next: EngineChoice) => {
    setEngine(next);
    restart(next, false);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>lunchrush</h1>
          <p>Restaurant orders that keep syncing when the internet drops. A learning project inspired by Ditto.</p>
        </div>
        <div className="top-controls">
          <div className="segmented" role="group" aria-label="Sync engine">
            <button aria-pressed={engine === 'crdt'} onClick={() => switchEngine('crdt')}>
              CRDT
            </button>
            <button aria-pressed={engine === 'naive'} onClick={() => switchEngine('naive')}>
              Naive last-write-wins
            </button>
          </div>
          <button className="btn primary" onClick={() => restart(engine, true)}>
            {world.playing ? '↺ Restart' : '▶ Play lunch rush'}
          </button>
        </div>
      </header>

      {world.caption && (
        <div className={`caption${world.playing ? '' : ' done'}`} role="status" aria-live="polite">
          <span className="caption-step">
            {world.caption.step} / {world.caption.total}
          </span>
          <span className="caption-text">{world.caption.text}</span>
          {!world.playing && (
            <button className="caption-close" aria-label="Dismiss" onClick={() => (world.caption = null)}>
              ✕
            </button>
          )}
          <span className="caption-bar" style={{ width: `${(world.caption.step / world.caption.total) * 100}%` }} />
        </div>
      )}

      <section className="network card">
        <Topology
          world={world}
          onToggle={(a: Device, b: Device) => world.setLan(a, b, !world.lanUp(a, b))}
        />
        <div className="network-side">
          <button
            className={`btn ${world.internetUp ? 'danger' : 'success'}`}
            onClick={() => world.setInternet(!world.internetUp)}
          >
            {world.internetUp ? '✂ Cut the internet' : '↻ Restore the internet'}
          </button>
          <CloudStatus world={world} />
          <p className="hint">Click a Wi-Fi line in the diagram to cut it. Click again to restore it.</p>
          <p className="engine-note">
            {engine === 'crdt'
              ? 'CRDT: every device merges everyone’s edits. Nothing is overwritten, and status only moves forward.'
              : 'Naive: each device keeps one whole copy, and the most recently saved copy replaces the others.'}
          </p>
        </div>
      </section>

      <main className="panels">
        {DEVICES.map((device) => {
          const station = world.stations[device];
          const peers = world.lanPeers(device);
          return (
            <Panel
              key={device}
              device={device}
              orders={world.orders(device)}
              status={
                <>
                  <span className={`dot ${peers.length > 0 ? 'on' : 'off'}`} />
                  {peers.length > 0 ? `Wi-Fi: ${peers.map((p) => DEVICE_LABEL[p]).join(', ')}` : 'Wi-Fi: offline'}
                  {world.uplink() === device && <span className="tag">store uplink</span>}
                </>
              }
              footer={<SyncState world={world} node={device} />}
              actions={{
                newOrder: device === 'kitchen' ? undefined : () => station.newOrder(),
                addItem: (id) => station.addItem(id),
                advance: (id) => station.advance(id),
                cancel: (id) => station.cancel(id),
              }}
            />
          );
        })}
      </main>

      <SyncLog entries={world.journal.entries} />
      <Footer>
        <a href="?mode=tabs">Multi-tab mode</a>: open each device in its own browser tab. They sync through
        BroadcastChannel, with no server.
      </Footer>
    </div>
  );
}

function CloudStatus({ world }: { world: DemoWorld }) {
  const lag = world.cloudLag();
  const text = !world.internetUp
    ? lag.inSync
      ? 'Cloud: unreachable, but nothing new to send yet'
      : `Cloud: unreachable${lag.missingEdits !== undefined ? `, ${lag.missingEdits} edits waiting` : ', falling behind'}`
    : lag.inSync
      ? 'Cloud: up to date'
      : 'Cloud: catching up…';
  return <p className={`cloud-status ${lag.inSync ? 'ok' : 'behind'}`}>{text}</p>;
}

/** The sync metadata under each panel: a version vector for the CRDT, a document stamp for naive. */
function SyncState({ world, node }: { world: DemoWorld; node: string }) {
  const vv = world.versionVector(node);
  if (vv) {
    const entries = Object.entries(vv);
    return (
      <span title="For each device: how many of its edits this screen has, with no gaps">
        version vector{' '}
        <code>{entries.length === 0 ? '{}' : entries.map(([id, n]) => `${deviceOf(id)} ${n}`).join(' · ')}</code>
      </span>
    );
  }
  const doc = world.documentVersion(node);
  return (
    <span title="Naive sync compares only this stamp">
      whole copy saved by <code>{doc?.savedBy || 'nobody yet'}</code>
    </span>
  );
}
