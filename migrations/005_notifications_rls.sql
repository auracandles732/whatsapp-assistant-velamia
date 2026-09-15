-- La tabla notifications se creó sin RLS: con la clave pública de Supabase cualquiera
-- podría leerla. El backend usa la service key, que ignora RLS, así que no le afecta.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
