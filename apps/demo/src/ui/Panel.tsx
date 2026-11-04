import { isFinished, type OrderView, type Status } from '@lunchrush/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEVICE_LABEL, nextStage, orderLabel, STAGE_LABEL, type Device } from '../station';

const ICON: Record<Device, string> = { 'drive-thru': '🚗', counter: '🧾', kitchen: '🍳' };
const ACTION: Partial<Record<Status, string>> = { cooking: 'Start cooking', ready: 'Mark ready', picked_up: 'Picked up' };

export interface DeviceActions {
  newOrder?: () => void;
  addItem: (orderId: string) => void;
  advance: (orderId: string) => void;
  cancel: (orderId: string) => void;
}

interface PanelProps {
  device: Device;
  orders: OrderView[];
  status: ReactNode;
  footer: ReactNode;
  actions: DeviceActions;
}

/** One device's screen: its own copy of the orders, and the buttons staff would tap. */
export function Panel({ device, orders, status, footer, actions }: PanelProps) {
  const active = orders.filter((o) => !isFinished(o.status));
  const finished = orders.filter((o) => isFinished(o.status));
  return (
    <section className="panel" aria-label={DEVICE_LABEL[device]}>
      <header className="panel-head">
        <h2>
          <span aria-hidden="true">{ICON[device]}</span> {DEVICE_LABEL[device]}
        </h2>
        {actions.newOrder && (
          <button className="btn primary small" onClick={actions.newOrder}>
            + New order
          </button>
        )}
      </header>
      <div className="panel-status">{status}</div>
      <div className="orders">
        {orders.length === 0 && <p className="empty">No orders yet</p>}
        {[...active, ...finished].map((order) => (
          <OrderCard key={order.id} order={order} actions={actions} />
        ))}
      </div>
      <footer className="panel-foot">{footer}</footer>
    </section>
  );
}

function OrderCard({ order, actions }: { order: OrderView; actions: DeviceActions }) {
  const next = nextStage(order.status);
  const finished = isFinished(order.status);
  const flash = useFlash(`${order.status}|${order.items.map((i) => i.id).join(',')}|${order.info ? 1 : 0}`);
  return (
    <article className={`order${finished ? ' finished' : ''}${flash ? ' flash' : ''}`}>
      <div className="order-head">
        <span className="order-id">{orderLabel(order.id)}</span>
        <span className="customer">{order.info?.customer ?? 'details on the way…'}</span>
        <span className={`chip chip-${order.status}`}>{STAGE_LABEL[order.status]}</span>
      </div>
      <ul className="items">
        {order.items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
      <div className="actions">
        {next && (
          <button className="btn small" onClick={() => actions.advance(order.id)}>
            {order.status === 'canceled' ? 'Picked up anyway' : ACTION[next]}
          </button>
        )}
        {!finished && (
          <button className="btn small ghost" onClick={() => actions.addItem(order.id)}>
            + Item
          </button>
        )}
        {!finished && (
          <button className="btn small ghost danger" onClick={() => actions.cancel(order.id)}>
            Cancel
          </button>
        )}
      </div>
    </article>
  );
}

/** True for a moment after `signature` changes, so a card that just synced glows. */
function useFlash(signature: string): boolean {
  const previous = useRef(signature);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 800);
    return () => clearTimeout(timer);
  }, [signature]);
  return flash;
}
