import { useState } from 'react';
import type { SltpWireEvent } from '@socketlens/protocol/browser';
import { ConnectionPanel } from './components/ConnectionPanel';
import { SessionPanel } from './components/SessionPanel';
import { ScenarioEditor } from './components/ScenarioEditor';
import { Timeline } from './components/Timeline';
import { ResultView } from './components/ResultView';
import { MessageInspector } from './components/MessageInspector';
import { useBridge } from './hooks/useBridge';

export function App() {
  const bridge = useBridge();
  const [selectedEvent, setSelectedEvent] = useState<SltpWireEvent | undefined>();

  const mockAddress = bridge.currentSession
    ? `${bridge.currentSession.mockHost}:${bridge.currentSession.mockPort}`
    : undefined;

  return (
    <div className="app">
      <header className="app-header">
        <h1>SocketLens TCP</h1>
        <p className="tagline">
          Local developer tool for designing, mocking, testing, and debugging custom
          application-layer protocols over raw TCP streams
        </p>
      </header>

      <div className="app-layout">
        <aside className="left-panel">
          <ConnectionPanel
            status={bridge.status}
            connecting={bridge.connecting}
            onConnect={bridge.connect}
            onDisconnect={bridge.disconnect}
          />
          <SessionPanel
            sessions={bridge.sessions}
            currentSession={bridge.currentSession}
            rules={bridge.rules}
            busy={bridge.busy}
            connected={bridge.status.connected}
            onSelectSession={bridge.selectSession}
            onCreateSession={bridge.createSession}
            onCloseSession={bridge.closeSession}
            onAddRule={bridge.addRule}
            onUpdateRule={bridge.updateRule}
            onDeleteRule={bridge.deleteRule}
          />
        </aside>

        <main className="center-panel">
          <ScenarioEditor
            busy={bridge.busy}
            canRun={bridge.currentSession !== undefined && bridge.status.connected}
            mockAddress={mockAddress}
            onRun={bridge.runTest}
            onSendRaw={bridge.sendRaw}
          />
          <Timeline
            events={bridge.wireEvents}
            selectedSeq={selectedEvent?.seq}
            onSelect={setSelectedEvent}
            onClear={bridge.clearTimeline}
          />
        </main>

        <aside className="right-panel">
          <ResultView
            result={bridge.lastResult}
            history={bridge.results}
            onSelectResult={bridge.loadResult}
          />
          <MessageInspector event={selectedEvent} />
        </aside>
      </div>

      {bridge.notice && (
        <div className={`notice notice-${bridge.notice.level}`} key={bridge.notice.key}>
          {bridge.notice.text}
        </div>
      )}
    </div>
  );
}
