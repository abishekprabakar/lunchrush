import { useEffect, useState } from 'react';
import { DEVICE_LABEL, DEVICES, deviceOf, type Device } from '../station';
import { TabPeer } from '../tabs';
import { Footer } from './Footer';
import { Panel } from './Panel';
import { SyncLog } from './SyncLog';

const CHANNEL = 'lunchrush-demo';

/** Multi-tab mode: this tab is one device, and other tabs are the others. */
export function TabsApp() {
  const fromUrl = new URLSearchParams(location.search).get('role');
  const [role, setRole] = useState<Device | null>(DEVICES.includes(fromUrl as Device) ? (fromUrl as Device) : null);

  if (!role) {
    return (
      <div className="app">
        <TabsHeader />
        <section className="card picker">
          <h2>Which device is this tab?</h2>
          <p>Pick one here, then open the others in new tabs. Every tab keeps its own copy of the orders.</p>
          <div className="picker-buttons">
            {DEVICES.map((d) => (
              <button
                key={d}
                className="btn primary"
                onClick={() => {
                  history.replaceState(null, '', `?mode=tabs&role=${d}`);
                  setRole(d);
                }}
              >
                {DEVICE_LABEL[d]}
              </button>
            ))}
          </div>
        </section>
        <Footer />
      </div>
    );
  }
  return <TabDevice role={role} />;
}

function TabDevice({ role }: { role: Device }) {
  const [peer] = useState(() => new TabPeer(role, new BroadcastChannel(CHANNEL)));
  const [, setFrame] = useState(0);
  useEffect(() => {
    peer.onChange = () => setFrame((f) => f + 1);
    peer.start(600);
    const timer = setInterval(() => setFrame((f) => f + 1), 1_000); // refresh "connected tabs"
    return () => {
      peer.stop();
      clearInterval(timer);
    };
  }, [peer]);

  const connected = peer.connectedPeers();
  const others = DEVICES.filter((d) => d !== role);
  const vv = Object.entries(peer.replica.versionVector());
  return (
    <div className="app">
      <TabsHeader />
      <section className="card tabs-bar">
        <p>
          This tab is the <strong>{DEVICE_LABEL[role]}</strong>. Open the others:{' '}
          {others.map((d, i) => (
            <span key={d}>
              {i > 0 && ' · '}
              <a href={`?mode=tabs&role=${d}`} target="_blank" rel="noreferrer">
                {DEVICE_LABEL[d]} ↗
              </a>
            </span>
          ))}
        </p>
        <label className="switch">
          <input type="checkbox" checked={peer.online} onChange={(e) => peer.setOnline(e.target.checked)} />
          <span>{peer.online ? 'Online' : 'Offline'}</span>
        </label>
      </section>
      <main className="panels single">
        <Panel
          device={role}
          orders={peer.orders()}
          status={
            <>
              <span className={`dot ${peer.online && connected.length > 0 ? 'on' : 'off'}`} />
              {!peer.online
                ? 'Offline: edits stay on this tab until you go back online'
                : connected.length > 0
                  ? `Connected tabs: ${connected.map((d) => DEVICE_LABEL[d as Device] ?? d).join(', ')}`
                  : 'No other tabs yet'}
            </>
          }
          footer={
            <span>
              version vector{' '}
              <code>{vv.length === 0 ? '{}' : vv.map(([id, n]) => `${deviceOf(id)} ${n}`).join(' · ')}</code>
            </span>
          }
          actions={{
            newOrder: role === 'kitchen' ? undefined : () => peer.station.newOrder(),
            addItem: (id) => peer.station.addItem(id),
            advance: (id) => peer.station.advance(id),
            cancel: (id) => peer.station.cancel(id),
          }}
        />
      </main>
      <SyncLog entries={peer.journal.entries} emptyText="Nothing yet. Take an order in a drive-thru or counter tab." />
      <Footer>
        Tabs sync through the browser’s BroadcastChannel, with no server. Multi-tab mode always uses the CRDT.{' '}
        <a href="./">Back to the one-page demo</a>.
      </Footer>
    </div>
  );
}

function TabsHeader() {
  return (
    <header className="top">
      <div className="brand">
        <h1>lunchrush</h1>
        <p>Multi-tab mode: each tab is one device. Go offline in one, keep working, then reconnect.</p>
      </div>
    </header>
  );
}
