// A Vercel-node function (pages/api style). On chain this is route 0 of the
// site program; the gateway answers it with a free simulateTransaction.
export default function handler(req, res) {
  const name = req.query.name || 'anon';
  res.status(200).json({
    hello: name,
    from: 'a Pinocchio program on Solana',
    method: req.method,
    site: process.env.SITE_NAME,
    ua: req.headers['user-agent'] || null,
  });
}
