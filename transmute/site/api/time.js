// Date.now() is the cluster clock; there is no wall clock in a program.
export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({ now: Date.now(), iso: new Date().toISOString(), note: 'from the Clock sysvar of the slot the read was simulated in' });
}
