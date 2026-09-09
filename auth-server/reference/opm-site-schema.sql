--
-- PostgreSQL database dump
--

\restrict 3K9WTkLybJDQpSoeMuRcc7TMTCWiMvViodJIJsESdUfXx5c3eRFomVf0llsqVQl

-- Dumped from database version 17.11 (Debian 17.11-1.pgdg12+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: article; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article (
    id integer NOT NULL,
    title character varying(255) NOT NULL,
    content text NOT NULL,
    published_date timestamp without time zone,
    url character varying(155),
    image character varying(255),
    categorie character varying(50) DEFAULT 'Actualité'::character varying NOT NULL,
    auteur character varying(50) DEFAULT 'Mélodia'::character varying NOT NULL
);


--
-- Name: article_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_id_seq OWNED BY public.article.id;


--
-- Name: combats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.combats (
    id integer NOT NULL,
    joueur_id integer NOT NULL,
    adversaire character varying(80) NOT NULL,
    contexte character varying(160) DEFAULT ''::character varying NOT NULL,
    gain bigint DEFAULT 0 NOT NULL,
    resultat character varying(10) DEFAULT 'victoire'::character varying NOT NULL,
    date timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: combats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.combats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: combats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.combats_id_seq OWNED BY public.combats.id;


--
-- Name: contact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(120) NOT NULL,
    option character varying(50) NOT NULL,
    message text NOT NULL
);


--
-- Name: contact_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_id_seq OWNED BY public.contact.id;


--
-- Name: equipages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipages (
    id integer NOT NULL,
    nom character varying(120) NOT NULL,
    reputation integer NOT NULL,
    membres integer NOT NULL,
    iles text NOT NULL,
    caisse bigint DEFAULT 0 NOT NULL,
    fondation timestamp without time zone,
    jolly_roger character varying(255) DEFAULT ''::character varying NOT NULL,
    devise character varying(150) DEFAULT ''::character varying NOT NULL
);


--
-- Name: equipages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipages_id_seq OWNED BY public.equipages.id;


--
-- Name: equipe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipe (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    titre character varying(100) NOT NULL,
    domaine character varying(100) NOT NULL
);


--
-- Name: equipe_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.equipe_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: equipe_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.equipe_id_seq OWNED BY public.equipe.id;


--
-- Name: iles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.iles (
    id integer NOT NULL,
    nom character varying(120) NOT NULL,
    equipage_id integer,
    detenteur character varying(120) DEFAULT ''::character varying NOT NULL,
    image character varying(255) DEFAULT ''::character varying NOT NULL,
    taxe_jour integer DEFAULT 0 NOT NULL,
    detenue_depuis timestamp without time zone,
    assauts_repousses integer DEFAULT 0 NOT NULL,
    fortifications integer DEFAULT 0 NOT NULL,
    niveau_murs integer DEFAULT 0 NOT NULL,
    statut character varying(40) DEFAULT 'Sous contrôle'::character varying NOT NULL,
    principale boolean DEFAULT false NOT NULL
);


--
-- Name: iles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.iles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: iles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.iles_id_seq OWNED BY public.iles.id;


--
-- Name: produits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produits (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    price double precision NOT NULL,
    gigot integer
);


--
-- Name: produits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.produits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: produits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.produits_id_seq OWNED BY public.produits.id;


--
-- Name: securite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.securite (
    id integer NOT NULL,
    tokenpaiement character varying(50)
);


--
-- Name: securite_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.securite_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: securite_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.securite_id_seq OWNED BY public.securite.id;


--
-- Name: statistiques; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statistiques (
    id integer NOT NULL,
    joueurs_en_ligne integer NOT NULL,
    record_joueurs integer NOT NULL,
    record_date character varying(50) NOT NULL,
    evenement_nom character varying(150) NOT NULL,
    evenement_date timestamp without time zone,
    votes integer NOT NULL,
    votes_objectif integer NOT NULL,
    dons_collecte integer NOT NULL,
    dons_objectif integer NOT NULL,
    donateurs integer NOT NULL,
    server_ip character varying(120) NOT NULL,
    launcher_windows character varying(255) NOT NULL,
    launcher_mac character varying(255) NOT NULL,
    launcher_linux character varying(255) NOT NULL
);


--
-- Name: statistiques_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.statistiques_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: statistiques_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.statistiques_id_seq OWNED BY public.statistiques.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    email character varying(120) NOT NULL,
    password_hash character varying(255) NOT NULL,
    datejoin timestamp without time zone,
    age integer,
    genre character varying(50) NOT NULL,
    provenance character varying(50) NOT NULL,
    faction character varying(50) NOT NULL,
    race character varying(50) NOT NULL,
    specialisation character varying(50) NOT NULL,
    equipage character varying(120) NOT NULL,
    territoires character varying(120) NOT NULL,
    prime integer,
    berry integer,
    metier character varying(50) NOT NULL,
    niveaubase integer NOT NULL,
    niveauhaki integer,
    niveaufdd integer,
    nomfdd character varying(50) NOT NULL,
    niveaumetier integer NOT NULL,
    niveaucrochetage integer NOT NULL,
    niveauminage integer NOT NULL,
    niveaubuchage integer NOT NULL,
    niveaucueillette integer NOT NULL,
    niveauchasse integer NOT NULL,
    niveaupeche integer NOT NULL,
    gigot integer,
    tokenpaiement character varying(50),
    tempsdejeu integer DEFAULT 0 NOT NULL,
    derniereconnexion timestamp without time zone,
    role_equipage character varying(50) DEFAULT ''::character varying NOT NULL,
    titres text DEFAULT ''::text NOT NULL,
    victoires_pvp integer DEFAULT 0 NOT NULL,
    defaites_pvp integer DEFAULT 0 NOT NULL,
    serie_victoires integer DEFAULT 0 NOT NULL,
    reputation_pirate integer DEFAULT 0 NOT NULL,
    reputation_marine integer DEFAULT 0 NOT NULL,
    reputation_civil integer DEFAULT 0 NOT NULL,
    votes_mois integer DEFAULT 0 NOT NULL
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: article id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article ALTER COLUMN id SET DEFAULT nextval('public.article_id_seq'::regclass);


--
-- Name: combats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combats ALTER COLUMN id SET DEFAULT nextval('public.combats_id_seq'::regclass);


--
-- Name: contact id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact ALTER COLUMN id SET DEFAULT nextval('public.contact_id_seq'::regclass);


--
-- Name: equipages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipages ALTER COLUMN id SET DEFAULT nextval('public.equipages_id_seq'::regclass);


--
-- Name: equipe id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipe ALTER COLUMN id SET DEFAULT nextval('public.equipe_id_seq'::regclass);


--
-- Name: iles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.iles ALTER COLUMN id SET DEFAULT nextval('public.iles_id_seq'::regclass);


--
-- Name: produits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produits ALTER COLUMN id SET DEFAULT nextval('public.produits_id_seq'::regclass);


--
-- Name: securite id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.securite ALTER COLUMN id SET DEFAULT nextval('public.securite_id_seq'::regclass);


--
-- Name: statistiques id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statistiques ALTER COLUMN id SET DEFAULT nextval('public.statistiques_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: alembic_version; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] alembic_version


--
-- Data for Name: article; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] article


--
-- Data for Name: combats; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] combats


--
-- Data for Name: contact; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] contact


--
-- Data for Name: equipages; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] equipages


--
-- Data for Name: equipe; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] equipe


--
-- Data for Name: iles; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] iles


--
-- Data for Name: produits; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] produits


--
-- Data for Name: securite; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] securite


--
-- Data for Name: statistiques; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] statistiques


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

-- [donnees omises] users


--
-- Name: article_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.article_id_seq', 78, true);


--
-- Name: combats_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.combats_id_seq', 1, false);


--
-- Name: contact_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.contact_id_seq', 1, false);


--
-- Name: equipages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.equipages_id_seq', 1, false);


--
-- Name: equipe_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.equipe_id_seq', 1, false);


--
-- Name: iles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.iles_id_seq', 1, false);


--
-- Name: produits_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.produits_id_seq', 1, true);


--
-- Name: securite_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.securite_id_seq', 1, false);


--
-- Name: statistiques_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.statistiques_id_seq', 1, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 10, true);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: article article_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article
    ADD CONSTRAINT article_pkey PRIMARY KEY (id);


--
-- Name: combats combats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combats
    ADD CONSTRAINT combats_pkey PRIMARY KEY (id);


--
-- Name: contact contact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact
    ADD CONSTRAINT contact_pkey PRIMARY KEY (id);


--
-- Name: equipages equipages_nom_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipages
    ADD CONSTRAINT equipages_nom_key UNIQUE (nom);


--
-- Name: equipages equipages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipages
    ADD CONSTRAINT equipages_pkey PRIMARY KEY (id);


--
-- Name: equipe equipe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipe
    ADD CONSTRAINT equipe_pkey PRIMARY KEY (id);


--
-- Name: iles iles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.iles
    ADD CONSTRAINT iles_pkey PRIMARY KEY (id);


--
-- Name: produits produits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produits
    ADD CONSTRAINT produits_pkey PRIMARY KEY (id);


--
-- Name: securite securite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.securite
    ADD CONSTRAINT securite_pkey PRIMARY KEY (id);


--
-- Name: statistiques statistiques_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statistiques
    ADD CONSTRAINT statistiques_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_name_key UNIQUE (name);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_combats_joueur; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_combats_joueur ON public.combats USING btree (joueur_id, date DESC);


--
-- Name: idx_iles_equipage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_iles_equipage ON public.iles USING btree (equipage_id);


--
-- Name: combats combats_joueur_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combats
    ADD CONSTRAINT combats_joueur_id_fkey FOREIGN KEY (joueur_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: iles iles_equipage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.iles
    ADD CONSTRAINT iles_equipage_id_fkey FOREIGN KEY (equipage_id) REFERENCES public.equipages(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict 3K9WTkLybJDQpSoeMuRcc7TMTCWiMvViodJIJsESdUfXx5c3eRFomVf0llsqVQl

