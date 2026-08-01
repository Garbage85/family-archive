migrate((app) => {
  const users = app.findCollectionByNameOrId('users');

  users.authRule = '';
  users.listRule = "@request.auth.role = 'admin' || id = @request.auth.id";
  users.viewRule = "@request.auth.role = 'admin' || id = @request.auth.id";
  users.createRule = null;
  users.updateRule = null;
  users.deleteRule = null;

  try {
    const field = users.fields.getByName('name');
    field.required = true;
    field.max = 120;
    field.presentable = true;
  } catch {
    users.fields.add(new TextField({
      name: 'name',
      required: true,
      max: 120,
      presentable: true,
    }));
  }

  try {
    const field = users.fields.getByName('role');
    field.required = true;
    field.maxSelect = 1;
    field.values = ['viewer', 'member', 'admin'];
  } catch {
    users.fields.add(new SelectField({
      name: 'role',
      required: true,
      maxSelect: 1,
      values: ['viewer', 'member', 'admin'],
    }));
  }

  app.save(users);

  const trees = new Collection({
    type: 'base',
    name: 'trees',
    listRule: "@request.auth.id != ''",
    viewRule: "@request.auth.id != ''",
    createRule: "@request.auth.role = 'admin'",
    updateRule: "@request.auth.role = 'admin'",
    deleteRule: "@request.auth.role = 'admin'",
    fields: [
      { name: 'name', type: 'text', required: true, max: 160 },
      { name: 'data', type: 'json', required: true, maxSize: 10485760 },
      { name: 'revision', type: 'number', required: true, min: 1, onlyInt: true },
      {
        name: 'updated_by',
        type: 'relation',
        required: false,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: 'created', type: 'autodate', onCreate: true },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
  });
  app.save(trees);

  const proposals = new Collection({
    type: 'base',
    name: 'proposals',
    listRule: "@request.auth.id != '' && (author = @request.auth.id || @request.auth.role = 'admin')",
    viewRule: "@request.auth.id != '' && (author = @request.auth.id || @request.auth.role = 'admin')",
    createRule: "(@request.auth.role = 'member' || @request.auth.role = 'admin') && @request.body.author = @request.auth.id && @request.body.status = 'pending'",
    updateRule: "@request.auth.role = 'admin'",
    deleteRule: "@request.auth.role = 'admin' || (author = @request.auth.id && status = 'pending')",
    fields: [
      {
        name: 'tree',
        type: 'relation',
        required: true,
        maxSelect: 1,
        collectionId: trees.id,
        cascadeDelete: true,
      },
      {
        name: 'author',
        type: 'relation',
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: true,
      },
      { name: 'base_revision', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'data', type: 'json', required: true, maxSize: 10485760 },
      { name: 'comment', type: 'text', max: 500 },
      {
        name: 'status',
        type: 'select',
        required: true,
        maxSelect: 1,
        values: ['pending', 'approved', 'rejected'],
      },
      {
        name: 'reviewed_by',
        type: 'relation',
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: 'reviewed_at', type: 'date' },
      { name: 'review_note', type: 'text', max: 500 },
      { name: 'created', type: 'autodate', onCreate: true },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
  });
  app.save(proposals);

  const media = new Collection({
    type: 'base',
    name: 'media',
    listRule: "@request.auth.id != ''",
    viewRule: "@request.auth.id != ''",
    createRule: "(@request.auth.role = 'member' || @request.auth.role = 'admin') && @request.body.author = @request.auth.id",
    updateRule: "author = @request.auth.id || @request.auth.role = 'admin'",
    deleteRule: "author = @request.auth.id || @request.auth.role = 'admin'",
    fields: [
      { name: 'person_id', type: 'text', required: true, max: 80 },
      {
        name: 'author',
        type: 'relation',
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: true,
      },
      {
        name: 'file',
        type: 'file',
        required: true,
        maxSelect: 1,
        maxSize: 10485760,
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        thumbs: ['320x320'],
      },
      { name: 'created', type: 'autodate', onCreate: true },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_media_person_id ON media (person_id)',
    ],
  });
  app.save(media);

  const initialTree = new Record(trees);
  initialTree.set('name', 'Древо семьи');
  initialTree.set('revision', 1);
  initialTree.set('data', [
    {
      id: 'root-person',
      data: {
        gender: 'M',
        first_name: 'Алексей',
        last_name: '',
        middle_name: '',
        birth_date: '1985-12-08',
        death_date: '',
        birth_place: '',
        occupation: '',
        notes: '',
        avatar: '',
      },
      rels: { parents: [], spouses: [], children: [] },
    },
  ]);
  app.save(initialTree);
}, (app) => {
  for (const name of ['media', 'proposals', 'trees']) {
    try {
      app.delete(app.findCollectionByNameOrId(name));
    } catch {
      // Коллекция могла быть удалена вручную.
    }
  }
});
