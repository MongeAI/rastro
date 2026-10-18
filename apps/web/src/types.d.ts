declare module '*.css';

declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}

declare module 'cytoscape-layout-utilities' {
  import type { Ext } from 'cytoscape';
  const layoutUtilities: Ext;
  export default layoutUtilities;
}

declare module '*?url' {
  const url: string;
  export default url;
}
