import { loadPost } from '../../../lib/posts';

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <article>{loadPost(slug)}</article>;
}
