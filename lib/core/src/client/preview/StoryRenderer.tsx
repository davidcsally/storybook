import React from 'react';
import ReactDOM from 'react-dom';
import { document } from 'global';
import AnsiToHtml from 'ansi-to-html';

import { StoryId, StoryKind, ViewMode, Channel } from '@storybook/addons';
import Events from '@storybook/core-events';
import { logger } from '@storybook/client-logger';
import { StoryStore } from '@storybook/client-api';

import { NoDocs } from './NoDocs';
import { RenderStoryFunction, RenderContext } from './types';

// We have "changed" story if this changes
interface RenderMetadata {
  id: StoryId;
  kind: StoryKind;
  revision: number;
  viewMode: ViewMode;
}

type Layout = 'centered' | 'fullscreen' | 'padded';
type StyleKeyValue = { centered: string; fullscreen: string; padded: string };

const classes = {
  MAIN: 'sb-show-main',
  NOPREVIEW: 'sb-show-nopreview',
  ERROR: 'sb-show-errordisplay',
};

const ansiConverter = new AnsiToHtml({
  escapeXML: true,
});

/**
 * StoryRenderer is responsible for rendering the correct story to the screen
 *
 * It is very much concerned with drawing to the screen and will do things like change classes
 * on the body etc.
 */
export class StoryRenderer {
  render: RenderStoryFunction;

  channel?: Channel;

  storyStore: StoryStore;

  previousMetadata?: RenderMetadata;

  previousStyles?: string;

  constructor({
    render,
    channel,
    storyStore,
  }: {
    render: RenderStoryFunction;
    channel?: Channel;
    storyStore: StoryStore;
  }) {
    this.render = render;
    this.channel = channel;
    this.storyStore = storyStore;

    this.setupListeners();
  }

  setupListeners() {
    // Channel can be null in StoryShots
    if (this.channel) {
      this.channel.on(Events.RENDER_CURRENT_STORY, () => this.renderCurrentStory(false));
      this.channel.on(Events.STORY_ARGS_UPDATED, () => this.forceReRender());
      this.channel.on(Events.FORCE_RE_RENDER, () => this.forceReRender());
    }
  }

  forceReRender() {
    this.renderCurrentStory(true);
  }

  renderCurrentStory(forceRender: boolean) {
    const { storyStore } = this;

    const loadError = storyStore.getError();
    if (loadError) {
      this.showErrorDisplay(loadError);
      return;
    }

    const { storyId, viewMode: urlViewMode } = storyStore.getSelection();

    const data = storyStore.fromId(storyId);
    const { kind, id, parameters = {} } = data || {};
    const { docsOnly, layout } = parameters;

    const metadata: RenderMetadata = {
      id,
      kind,
      viewMode: docsOnly ? 'docs' : (urlViewMode as ViewMode),
      revision: storyStore.getRevision(),
    };

    this.applyLayout(layout);

    const context: RenderContext = {
      id: storyId, // <- in case data is null, at least we'll know what we tried to render
      ...data,
      forceRender,
      showMain: () => this.showMain(),
      showError: ({ title, description }: { title: string; description: string }) =>
        this.renderError({ title, description }),
      showException: (err: Error) => this.renderException(err),
    };

    this.renderStoryIfChanged({ metadata, context });
  }

  renderStoryIfChanged({
    metadata,
    context,
  }: {
    metadata: RenderMetadata;
    context: RenderContext;
  }) {
    const { forceRender, name } = context;

    const { previousMetadata, storyStore } = this;

    const storyChanged = !previousMetadata || previousMetadata.id !== metadata.id;
    const revisionChanged = !previousMetadata || previousMetadata.revision !== metadata.revision;
    const viewModeChanged = !previousMetadata || previousMetadata.viewMode !== metadata.viewMode;
    const kindChanged = !previousMetadata || previousMetadata.kind !== metadata.kind;

    // Don't re-render the story if nothing has changed to justify it
    if (!forceRender && !storyChanged && !revisionChanged && !viewModeChanged) {
      this.channel.emit(Events.STORY_UNCHANGED, {
        ...metadata,
        name,
      });
      return;
    }

    // If we are rendering something new (as opposed to re-rendering the same or first story), emit
    if (!forceRender && previousMetadata && !revisionChanged) {
      this.channel.emit(Events.STORY_CHANGED, metadata.id);
    }

    switch (previousMetadata ? previousMetadata.viewMode : 'story') {
      case 'docs':
        if (kindChanged || viewModeChanged) {
          this.storyStore.cleanHooksForKind(previousMetadata.kind);
          ReactDOM.unmountComponentAtNode(document.getElementById('docs-root'));
        }
        break;
      case 'story':
      default:
        if (previousMetadata && (storyChanged || viewModeChanged)) {
          this.storyStore.cleanHooks(previousMetadata.id);
          ReactDOM.unmountComponentAtNode(document.getElementById('root'));
        }
    }

    // Docs view renders into a different root ID to avoid conflicts
    // with the user's view layer. Therefore we need to clean up whenever
    // we transition between view modes
    if (viewModeChanged) {
      switch (metadata.viewMode) {
        case 'docs': {
          this.showMain();
          this.showDocs();
          break;
        }
        case 'story':
        default: {
          if (previousMetadata) {
            this.showStory();
          }
        }
      }
    }
    // Given a cleaned up state, render the appropriate view mode
    switch (metadata.viewMode) {
      case 'docs': {
        this.renderDocs({ context, storyStore });
        break;
      }
      case 'story':
      default: {
        this.renderStory({ context });
        break;
      }
    }

    this.previousMetadata = metadata;

    if (!forceRender && metadata.viewMode !== 'docs') {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
  }

  applyLayout(layout: Layout) {
    const layouts: StyleKeyValue = {
      centered: `
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
        margin: 0;
        padding: 1rem;
        box-sizing: border-box;
      `,
      fullscreen: `
        margin: 0;
      `,
      padded: `
        margin: 0;
        padding: 1rem;
      `,
    };
    const styles = layouts[layout] || layouts.padded;

    if (styles !== this.previousStyles) {
      document.body.style = styles;
      this.previousStyles = styles;
    }
  }

  showErrorDisplay({ message = '', stack = '' }) {
    document.getElementById('error-message').innerHTML = ansiConverter.toHtml(message);
    document.getElementById('error-stack').innerHTML = ansiConverter.toHtml(stack);

    document.body.classList.remove(classes.MAIN);
    document.body.classList.remove(classes.NOPREVIEW);

    document.body.classList.add(classes.ERROR);
  }

  showNoPreview() {
    document.body.classList.remove(classes.MAIN);
    document.body.classList.remove(classes.ERROR);

    document.body.classList.add(classes.NOPREVIEW);
  }

  showMain() {
    document.body.classList.remove(classes.NOPREVIEW);
    document.body.classList.remove(classes.ERROR);

    document.body.classList.add(classes.MAIN);
  }

  showDocs() {
    document.getElementById('root').setAttribute('hidden', 'true');
    document.getElementById('docs-root').removeAttribute('hidden');
  }

  showStory() {
    document.getElementById('docs-root').setAttribute('hidden', 'true');
    document.getElementById('root').removeAttribute('hidden');
  }

  renderStory({ context, context: { id, getDecorated } }: { context: RenderContext }) {
    if (getDecorated) {
      (async () => {
        try {
          await this.render(context);
          this.channel.emit(Events.STORY_RENDERED, id);
        } catch (err) {
          this.renderException(err);
        }
      })();
    } else {
      this.showNoPreview();
      this.channel.emit(Events.STORY_MISSING, id);
    }
  }

  renderDocs({ context, storyStore }: { context: RenderContext; storyStore: StoryStore }) {
    const { kind, parameters, id } = context;
    if (id === '*' || !parameters) {
      return;
    }

    const docs = parameters.docs || {};
    const DocsContainer =
      docs.container || (({ children }: { children: Element }) => <>{children}</>);
    const Page = docs.page || NoDocs;
    // Docs context includes the storyStore. Probably it would be better if it didn't but that can be fixed in a later refactor
    ReactDOM.render(
      <DocsContainer context={{ storyStore, ...context }}>
        <Page />
      </DocsContainer>,
      document.getElementById('docs-root'),
      () => this.channel.emit(Events.DOCS_RENDERED, kind)
    );
  }

  // renderException is used if we fail to render the story and it is uncaught by the app layer
  renderException(err: Error) {
    this.channel.emit(Events.STORY_THREW_EXCEPTION, err);
    this.showErrorDisplay(err);

    // Log the stack to the console. So, user could check the source code.
    logger.error(err);
  }

  // renderError is used by the various app layers to inform the user they have done something
  // wrong -- for instance returned the wrong thing from a story
  renderError({ title, description }: { title: string; description: string }) {
    this.channel.emit(Events.STORY_ERRORED, { title, description });
    this.showErrorDisplay({
      message: title,
      stack: description,
    });
  }
}
