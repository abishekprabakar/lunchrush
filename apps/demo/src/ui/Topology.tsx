import { DEVICE_LABEL, DEVICES, type Device } from '../station';
import { CLOUD, type DemoWorld } from '../world';

const POS: Record<string, [number, number]> = {
  [CLOUD]: [320, 44],
  'drive-thru': [110, 176],
  counter: [320, 176],
  kitchen: [530, 176],
};
const ICON: Record<Device, string> = { 'drive-thru': '🚗', counter: '🧾', kitchen: '🍳' };

const LAN: { a: Device; b: Device; path: string; mid: [number, number] }[] = [
  { a: 'drive-thru', b: 'counter', path: 'M110,176 L320,176', mid: [215, 176] },
  { a: 'counter', b: 'kitchen', path: 'M320,176 L530,176', mid: [425, 176] },
  { a: 'drive-thru', b: 'kitchen', path: 'M110,176 Q320,330 530,176', mid: [320, 253] },
];

/**
 * The store's network. Wi-Fi lines can be clicked to cut and restore them.
 * The line to the cloud is solid for the device acting as the store's uplink.
 */
export function Topology({ world, onToggle }: { world: DemoWorld; onToggle: (a: Device, b: Device) => void }) {
  const uplink = world.uplink();
  const internet = world.internetUp;
  return (
    <svg className="topology" viewBox="0 0 640 270" role="group" aria-label="Store network diagram">
      {DEVICES.map((d) => {
        const [x, y] = POS[d];
        const state = !internet ? 'down' : uplink === d ? 'uplink' : 'idle';
        const active = world.recentlyActive(d, CLOUD) ? ' active' : '';
        return <line key={d} x1={x} y1={y - 26} x2={320} y2={70} className={`net net-${state}${active}`} />;
      })}

      {LAN.map(({ a, b, path, mid }) => {
        const up = world.lanUp(a, b);
        const active = up && world.recentlyActive(a, b) ? ' active' : '';
        const label = `${up ? 'Cut' : 'Restore'} Wi-Fi between ${DEVICE_LABEL[a]} and ${DEVICE_LABEL[b]}`;
        return (
          <g
            key={`${a}-${b}`}
            className={`lan ${up ? 'up' : 'down'}${active}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            onClick={() => onToggle(a, b)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle(a, b)}
          >
            <title>{label}</title>
            <path d={path} className="hit" />
            <path d={path} className="wire" />
            {!up && (
              <g transform={`translate(${mid[0]},${mid[1]})`} className="cut-mark">
                <circle r="11" />
                <path d="M-4,-4 L4,4 M4,-4 L-4,4" />
              </g>
            )}
          </g>
        );
      })}

      <g transform={`translate(${POS[CLOUD][0]},${POS[CLOUD][1]})`} className={`node cloud${internet ? '' : ' offline'}`}>
        <rect x="-62" y="-24" width="124" height="48" rx="24" />
        <text y="5">☁ Cloud · {world.orders(CLOUD).length}</text>
      </g>

      {DEVICES.map((d) => {
        const [x, y] = POS[d];
        return (
          <g key={d} transform={`translate(${x},${y})`} className="node device">
            <circle r="26" />
            <text y="8" className="emoji">
              {ICON[d]}
            </text>
            <text y="48" className="label">
              {DEVICE_LABEL[d]}
            </text>
            <g transform="translate(20,-20)" className="badge">
              <circle r="11" />
              <text y="4">{world.orders(d).length}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
