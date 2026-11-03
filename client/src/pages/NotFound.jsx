import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePageMeta } from '../components/Layout.jsx';
import { Empty } from '../components/ui.jsx';

export default function NotFound() {
  usePageMeta('Page not found');
  return (
    <div className="card">
      <Empty
        icon={Compass}
        title="This page doesn't exist"
        action={
          <Link className="btn btn-primary" to="/">
            Back to dashboard
          </Link>
        }
      >
        The link may be outdated, or the item was deleted.
      </Empty>
    </div>
  );
}
