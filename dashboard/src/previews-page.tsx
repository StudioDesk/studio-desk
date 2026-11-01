// Working features that are still being finished, chosen only for this browser.
import { Link } from '@tanstack/react-router';
import { setChatBox, useChatBox } from './chat-box';
import { Heading, Toggle } from './layout';

export function PreviewsPage({ projectId }: { projectId: string }) {
  const chatBox = useChatBox();
  return (
    <div className="sd-orgpage sd-previewspage">
      <Heading
        crumbs={[
          <Link key="settings" to="/p/$projectId/settings" params={{ projectId }}>
            Settings
          </Link>,
        ]}
        here="Previews"
        title="Previews"
        lead="These features work but are not finished, and your choices are kept in this browser."
      />
      <div className="sd-card sd-setsec">
        <div className="sd-setrow sd-setrow--first">
          <span className="sd-setrow__text">
            <b>The chat box (preview)</b>
            <span className="sd-meta">
              With it on, New idea opens a chat box beside the page; with it off, New idea works as it always has.
            </span>
          </span>
          <Toggle label="The chat box (preview)" on={chatBox} onChange={() => setChatBox(!chatBox)} />
        </div>
      </div>
    </div>
  );
}
