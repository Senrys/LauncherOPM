package fr.onepieceminecraft.opm.client;

import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.util.Optional;
import java.util.Set;
import net.minecraft.SharedConstants;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.packs.PackLocationInfo;
import net.minecraft.server.packs.PackResources;
import net.minecraft.server.packs.PackSelectionConfig;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.metadata.MetadataSectionSerializer;
import net.minecraft.server.packs.metadata.pack.PackMetadataSection;
import net.minecraft.server.packs.repository.PackCompatibility;
import net.minecraft.server.packs.repository.PackSource;
import net.minecraft.server.packs.resources.IoSupplier;
import net.minecraft.world.flag.FeatureFlagSet;
import net.neoforged.neoforge.event.AddPackFindersEvent;

/**
 * Les musiques du paquet chiffré (client/Pack), présentées à Minecraft comme un pack
 * de ressources interne, invisible du joueur : le moteur du jeu les lit comme
 * n'importe quel son.
 */
public final class PackSounds implements PackResources {
    private static final PackLocationInfo INFO = new PackLocationInfo("opm/sons", Component.literal("OPM"), PackSource.BUILT_IN,
            Optional.empty());
    private static final String PREFIX = "sounds/music/";

    public static void register(AddPackFindersEvent event) {
        if (event.getPackType() != PackType.CLIENT_RESOURCES) return;
        var supplier = new net.minecraft.server.packs.repository.Pack.ResourcesSupplier() {
            @Override
            public PackResources openPrimary(PackLocationInfo info) {
                return new PackSounds();
            }

            @Override
            public PackResources openFull(PackLocationInfo info, net.minecraft.server.packs.repository.Pack.Metadata metadata) {
                return new PackSounds();
            }
        };
        var metadata = new net.minecraft.server.packs.repository.Pack.Metadata(Component.literal("OPM"), PackCompatibility.COMPATIBLE,
                FeatureFlagSet.of(), java.util.List.of(), true);
        event.addRepositorySource(consumer -> consumer.accept(new net.minecraft.server.packs.repository.Pack(INFO, supplier, metadata,
                new PackSelectionConfig(true, net.minecraft.server.packs.repository.Pack.Position.BOTTOM, true))));
    }

    private static String inPack(ResourceLocation id) {
        if (!Opm.ID.equals(id.getNamespace()) || !id.getPath().startsWith(PREFIX)) return null;
        String name = "music/" + id.getPath().substring(PREFIX.length());
        return Pack.has(name) ? name : null;
    }

    @Override
    public IoSupplier<InputStream> getRootResource(String... elements) {
        return null;
    }

    @Override
    public IoSupplier<InputStream> getResource(PackType type, ResourceLocation id) {
        String name = type == PackType.CLIENT_RESOURCES ? inPack(id) : null;
        return name == null ? null : () -> Pack.open(name);
    }

    @Override
    public void listResources(PackType type, String namespace, String path, ResourceOutput output) {
        if (type != PackType.CLIENT_RESOURCES || !Opm.ID.equals(namespace)) return;
        for (String etat : new String[]{"creatrice", "corrompue"}) {
            ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, PREFIX + "xenodys_" + etat + ".ogg");
            String name = inPack(id);
            if (name != null && id.getPath().startsWith(path)) output.accept(id, () -> Pack.open(name));
        }
    }

    @Override
    public Set<String> getNamespaces(PackType type) {
        return type == PackType.CLIENT_RESOURCES ? Set.of(Opm.ID) : Set.of();
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> T getMetadataSection(MetadataSectionSerializer<T> serializer) {
        return serializer == PackMetadataSection.TYPE ? (T) new PackMetadataSection(Component.literal("OPM"),
                SharedConstants.getCurrentVersion().getPackVersion(PackType.CLIENT_RESOURCES), Optional.empty()) : null;
    }

    @Override
    public PackLocationInfo location() {
        return INFO;
    }

    @Override
    public void close() {
    }
}
